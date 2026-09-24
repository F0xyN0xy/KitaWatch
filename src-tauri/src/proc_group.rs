//! Process-group lifetime: sidecars must never outlive the app.
//!
//! lib.rs already kills sidecars on RunEvent::Exit, but that only covers a
//! graceful quit. An update (or a force-kill, or a crash) tears the main
//! process down without ever firing Exit — the Python/Node sidecars get
//! orphaned, keep holding ports 8000/8001/4000, AND on Windows they lock
//! their .exe files, which then blocks the updater from replacing them.
//! That is the whole "close them in Task Manager" dance.
//!
//! Windows: every spawned child is assigned to a Job Object created with
//! JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. The kernel then guarantees the
//! group dies with the app, no matter how the app died.
//!
//! Linux: children are armed with PR_SET_PDEATHSIG = SIGKILL in a pre_exec
//! hook (the startup-time kill_stragglers sweep in api_sidecar.rs stays as
//! the belt-and-suspenders path for zombies from BEFORE this existed).
//!
//! macOS: no cheap equivalent primitive — the graceful Exit path covers
//! normal quits there, and this module compiles to a no-op.

/// Pre-spawn hook: anything that must be armed before exec (Linux pdeathsig).
pub fn configure(cmd: &mut std::process::Command) {
    #[cfg(target_os = "linux")]
    linux::arm(cmd);
    #[cfg(not(target_os = "linux"))]
    let _ = cmd;
}

/// Post-spawn hook: attach a live child to the die-with-parent group.
pub fn register(child: &std::process::Child) {
    #[cfg(windows)]
    windows::register(child);
    #[cfg(not(windows))]
    let _ = child;
}

#[cfg(windows)]
mod windows {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    // Stored as an integer because raw pointers are not Sync and therefore
    // cannot live in a static. HANDLE is a *mut c_void in windows-sys; we
    // cast in and out at the API boundary. Deliberately never closed: when
    // the app exits for ANY reason the kernel closes this handle, the job
    // becomes handle-less, and KILL_ON_JOB_CLOSE terminates every member.
    static JOB: AtomicIsize = AtomicIsize::new(0);

    fn job() -> HANDLE {
        let cached = JOB.load(Ordering::Acquire);
        if cached != 0 {
            return cached as HANDLE;
        }
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                eprintln!("[kitawatch] warning: CreateJobObjectW failed — sidecars may outlive the app");
                return job;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
            {
                eprintln!(
                    "[kitawatch] warning: SetInformationJobObject failed ({}) — sidecars may outlive the app",
                    std::io::Error::last_os_error()
                );
                let _ = CloseHandle(job);
                return std::ptr::null_mut();
            }
            JOB.store(job as isize, Ordering::Release);
            job
        }
    }

    pub fn register(child: &std::process::Child) {
        let job = job();
        if job.is_null() {
            return;
        }
        unsafe {
            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child.id());
            if proc.is_null() {
                return;
            }
            // Best effort: if the app itself runs inside a job (CI, sandbox,
            // some launchers) this can fail — the Exit-path kill still covers
            // graceful quits, and the next launch's kill_stragglers sweep
            // reaps whatever is left.
            if AssignProcessToJobObject(job, proc) == 0 {
                eprintln!(
                    "[kitawatch] warning: could not add sidecar {} to kill-job ({})",
                    child.id(),
                    std::io::Error::last_os_error()
                );
            }
            let _ = CloseHandle(proc);
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::os::unix::process::CommandExt;

    pub fn arm(cmd: &mut std::process::Command) {
        unsafe {
            cmd.pre_exec(|| {
                // Die with the parent even when the parent dies violently
                // (SIGKILL has no atexit — this is the only reliable hook).
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                Ok(())
            });
        }
    }
}