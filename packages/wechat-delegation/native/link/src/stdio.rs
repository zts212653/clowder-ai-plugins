//! Bounded request framing and response serialization for the child process.
use crate::{account_service::AccountService, ipc};
use std::{
    io::{self, BufRead, Write},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
struct Shutdown(Option<Arc<AccountService>>);
impl Drop for Shutdown {
    fn drop(&mut self) {
        if let Some(service) = &self.0 {
            service.close();
        }
    }
}
struct Permit(Arc<AtomicUsize>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
fn write<W: Write>(writer: &Mutex<W>, value: &serde_json::Value) -> io::Result<()> {
    ipc::write_response(
        &mut *writer
            .lock()
            .map_err(|_| io::Error::other("response unavailable"))?,
        value,
    )
}
pub fn serve(
    reader: &mut impl BufRead,
    writer: impl Write + Send + 'static,
    service: Option<Arc<AccountService>>,
) -> io::Result<()> {
    let _shutdown = Shutdown(service.clone());
    let writer = Arc::new(Mutex::new(writer));
    let running = Arc::new(AtomicUsize::new(0));
    loop {
        match ipc::read_frame(reader) {
            Ok(Some(frame)) => {
                if ipc::is_blocking(&frame) && service.is_some() {
                    // Only network operations use worker slots. Cancellation,
                    // status and disconnect stay on the admission thread.
                    if running
                        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                            if n < 2 {
                                Some(n + 1)
                            } else {
                                None
                            }
                        })
                        .is_err()
                    {
                        write(&writer, &ipc::busy_response(&frame))?;
                        continue;
                    }
                    let permit = Permit(running.clone());
                    let service = service.clone();
                    let writer = writer.clone();
                    std::thread::Builder::new()
                        .name("wechat-network".into())
                        .spawn(move || {
                            let _permit = permit;
                            let reply = ipc::respond_with(&frame, service.as_deref());
                            if write(&writer, &reply).is_err() {
                                if let Some(service) = service {
                                    service.close();
                                }
                            }
                        })?;
                } else {
                    write(&writer, &ipc::respond_with(&frame, service.as_deref()))?;
                }
            }
            Ok(None) => return Ok(()),
            Err(_) => {
                write(&writer, &ipc::framing_error())?;
                return Err(io::Error::other("invalid frame"));
            }
        }
    }
}
