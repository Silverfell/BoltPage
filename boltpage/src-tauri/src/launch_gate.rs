//! The launch gate: decides which windows a launch may show.
//!
//! A plain launch restores the saved session, or shows a welcome window. A
//! document launch (argv files, or RunEvent::Opened) shows the requested
//! documents only. Which of the two a launch is can become known after the
//! startup windows were already created, so those are created hidden and
//! gated, and the decision is taken when each one asks to be shown.
//!
//! Every method is synchronous and takes the one lock for its whole body.
//! Callers record intent at event delivery, never from a spawned task: a
//! record deferred to a task races window creation (the original cold-start
//! session-restore bug).

use std::collections::HashSet;
use std::sync::Mutex;

#[derive(Default)]
struct State {
    /// True when argv carried files. Inert after startup.
    had_cli_args: bool,
    /// True once a document open was explicitly requested.
    requested: bool,
    /// Resolved path strings of every explicitly requested document.
    requested_paths: HashSet<String>,
    /// True once any explicitly requested document window was actually created.
    succeeded: bool,
    /// Labels of hidden startup windows (session restore + welcome) that have
    /// not reached their show moment yet.
    gated: HashSet<String>,
    /// Label of the welcome window the startup resolver may have created.
    welcome: Option<String>,
}

/// What show_window does with a window that reached its show moment.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ShowDecision {
    Show,
    /// Destroy the window unseen. Its session entry must be kept: the saved
    /// session has to survive a file launch so the next plain launch still
    /// restores it.
    Destroy,
}

#[derive(Default)]
pub(crate) struct LaunchGate(Mutex<State>);

impl LaunchGate {
    /// Records explicitly requested documents. `cli` marks argv files, which
    /// also makes the startup resolver skip session restore. A request that
    /// carries no file is not a document launch.
    pub(crate) fn request_documents(&self, paths: impl IntoIterator<Item = String>, cli: bool) {
        let mut state = self.0.lock().unwrap();
        if cli {
            state.had_cli_args = true;
            state.requested = true;
        }
        for path in paths {
            state.requested_paths.insert(path);
            state.requested = true;
        }
    }

    /// True when the startup resolver has nothing to do: argv windows were
    /// created in setup, or a document launch was already observed. A fast
    /// path only, not a correctness deadline: windows created after a false
    /// answer are still gated and decided at their show moment.
    pub(crate) fn skip_startup(&self) -> bool {
        let state = self.0.lock().unwrap();
        state.had_cli_args || state.requested
    }

    /// True while no document launch has been observed, so the welcome
    /// fallback may be created.
    pub(crate) fn welcome_allowed(&self) -> bool {
        !self.0.lock().unwrap().requested
    }

    /// Marks a window the startup resolver created as waiting for its show
    /// moment.
    pub(crate) fn gate(&self, label: &str) {
        self.0.lock().unwrap().gated.insert(label.to_string());
    }

    /// An explicit open landing on a window the startup resolver created
    /// un-gates it: the user asked for this file, so its show moment must
    /// show it.
    pub(crate) fn ungate(&self, label: &str) {
        self.0.lock().unwrap().gated.remove(label);
    }

    pub(crate) fn set_welcome(&self, label: String) {
        self.0.lock().unwrap().welcome = Some(label);
    }

    /// The show-time gate. `file` is the file the window shows, if any. A
    /// startup window reaching its show moment after a document launch was
    /// observed is destroyed unseen, unless it is itself a requested
    /// document: then it IS the doc window and must show (which also keeps
    /// the Opened dedupe from ever racing a destroy of the window it lands
    /// on). The label leaves the gate either way.
    pub(crate) fn on_show(&self, label: &str, file: Option<&str>) -> ShowDecision {
        let mut state = self.0.lock().unwrap();
        let was_gated = state.gated.remove(label);
        if !was_gated || !state.requested {
            return ShowDecision::Show;
        }
        match file {
            Some(path) if state.requested_paths.contains(path) => ShowDecision::Show,
            _ => ShowDecision::Destroy,
        }
    }

    /// Records the outcome of a batch of requested opens and returns the
    /// label of a welcome window to destroy, if any.
    ///
    /// When any open succeeded, the welcome window the startup resolver may
    /// have created is reclaimed, so a file launch never leaves a stray empty
    /// window beside the document. An unshown welcome is covered by on_show;
    /// this also removes one already shown, but only while pristine
    /// (`has_file` says no), so it never touches a document-bearing window.
    ///
    /// When every open failed and none ever succeeded, the launch intent is
    /// cleared so hidden startup windows still surface instead of leaving the
    /// app windowless.
    pub(crate) fn opens_finished(
        &self,
        opened_any: bool,
        has_file: impl FnOnce(&str) -> bool,
    ) -> Option<String> {
        let mut state = self.0.lock().unwrap();
        if opened_any {
            state.succeeded = true;
            let label = state.welcome.take()?;
            state.gated.remove(&label);
            return (!has_file(&label)).then_some(label);
        }
        if !state.succeeded {
            state.requested = false;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn plain_launch_resolves_startup_and_shows_its_windows() {
        let gate = LaunchGate::default();
        assert!(!gate.skip_startup());
        assert!(gate.welcome_allowed());

        gate.gate("session");
        assert_eq!(gate.on_show("session", Some("/a.md")), ShowDecision::Show);
    }

    #[test]
    fn cli_launch_skips_startup_resolution() {
        let gate = LaunchGate::default();
        gate.request_documents(paths(&["/a.md"]), true);
        assert!(gate.skip_startup());
        assert!(!gate.welcome_allowed());
    }

    #[test]
    fn observed_document_launch_skips_startup_resolution() {
        let gate = LaunchGate::default();
        gate.request_documents(paths(&["/a.md"]), false);
        assert!(gate.skip_startup());
        assert!(!gate.welcome_allowed());
    }

    #[test]
    fn request_without_files_is_not_a_document_launch() {
        let gate = LaunchGate::default();
        gate.request_documents(paths(&[]), false);
        assert!(!gate.skip_startup());
        assert!(gate.welcome_allowed());
    }

    /// The cold-start race: the request arrives after the startup windows
    /// were created but before they show.
    #[test]
    fn startup_window_is_destroyed_when_a_document_launch_is_observed_by_show() {
        let gate = LaunchGate::default();
        assert!(!gate.skip_startup());
        gate.gate("session");
        gate.gate("welcome");

        gate.request_documents(paths(&["/doc.md"]), false);

        assert_eq!(
            gate.on_show("session", Some("/old.md")),
            ShowDecision::Destroy
        );
        assert_eq!(gate.on_show("welcome", None), ShowDecision::Destroy);
    }

    #[test]
    fn startup_window_that_is_a_requested_document_shows() {
        let gate = LaunchGate::default();
        gate.gate("session");
        gate.request_documents(paths(&["/doc.md"]), false);
        assert_eq!(gate.on_show("session", Some("/doc.md")), ShowDecision::Show);
    }

    #[test]
    fn window_that_was_never_gated_always_shows() {
        let gate = LaunchGate::default();
        gate.request_documents(paths(&["/doc.md"]), false);
        assert_eq!(gate.on_show("other", Some("/x.md")), ShowDecision::Show);
        assert_eq!(gate.on_show("blank", None), ShowDecision::Show);
    }

    #[test]
    fn show_pops_the_label() {
        let gate = LaunchGate::default();
        gate.gate("session");
        assert_eq!(gate.on_show("session", Some("/old.md")), ShowDecision::Show);

        gate.request_documents(paths(&["/doc.md"]), false);
        assert_eq!(gate.on_show("session", Some("/old.md")), ShowDecision::Show);
    }

    #[test]
    fn explicit_open_landing_on_a_startup_window_ungates_it() {
        let gate = LaunchGate::default();
        gate.gate("session");
        gate.request_documents(paths(&["/doc.md"]), false);

        gate.ungate("session");

        assert_eq!(gate.on_show("session", Some("/old.md")), ShowDecision::Show);
    }

    #[test]
    fn successful_open_reclaims_a_pristine_welcome_once() {
        let gate = LaunchGate::default();
        gate.gate("welcome");
        gate.set_welcome("welcome".to_string());
        gate.request_documents(paths(&["/doc.md"]), false);

        assert_eq!(
            gate.opens_finished(true, |_| false),
            Some("welcome".to_string())
        );
        // Reclaimed: no longer gated, and not handed out again.
        assert_eq!(gate.on_show("welcome", None), ShowDecision::Show);
        assert_eq!(gate.opens_finished(true, |_| false), None);
    }

    #[test]
    fn welcome_that_took_a_file_is_not_reclaimed() {
        let gate = LaunchGate::default();
        gate.set_welcome("welcome".to_string());
        gate.request_documents(paths(&["/doc.md"]), false);

        assert_eq!(gate.opens_finished(true, |label| label == "welcome"), None);
        // Still taken: a later batch does not reconsider it.
        assert_eq!(gate.opens_finished(true, |_| false), None);
    }

    #[test]
    fn failed_opens_leave_the_welcome_alone() {
        let gate = LaunchGate::default();
        gate.set_welcome("welcome".to_string());
        gate.request_documents(paths(&["/doc.md"]), false);

        assert_eq!(gate.opens_finished(false, |_| false), None);
        assert_eq!(
            gate.opens_finished(true, |_| false),
            Some("welcome".to_string())
        );
    }

    #[test]
    fn all_opens_failed_and_none_ever_succeeded_resets_the_launch() {
        let gate = LaunchGate::default();
        gate.gate("session");
        gate.request_documents(paths(&["/doc.md"]), false);

        gate.opens_finished(false, |_| false);

        assert!(gate.welcome_allowed());
        assert_eq!(gate.on_show("session", Some("/old.md")), ShowDecision::Show);
    }

    #[test]
    fn requesting_the_same_document_again_after_a_reset_counts() {
        let gate = LaunchGate::default();
        gate.request_documents(paths(&["/doc.md"]), false);
        gate.opens_finished(false, |_| false);
        assert!(!gate.skip_startup());

        gate.request_documents(paths(&["/doc.md"]), false);
        assert!(gate.skip_startup());
    }

    #[test]
    fn failed_opens_after_a_success_do_not_reset_the_launch() {
        let gate = LaunchGate::default();
        gate.gate("session");
        gate.request_documents(paths(&["/doc.md"]), false);
        gate.opens_finished(true, |_| false);

        gate.request_documents(paths(&["/gone.md"]), false);
        gate.opens_finished(false, |_| false);

        assert!(!gate.welcome_allowed());
        assert_eq!(
            gate.on_show("session", Some("/old.md")),
            ShowDecision::Destroy
        );
    }
}
