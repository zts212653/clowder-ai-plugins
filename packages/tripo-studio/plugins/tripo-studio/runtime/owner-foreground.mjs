import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const SCRIPT = `use framework "AppKit"
set frontApplication to current application's NSWorkspace's sharedWorkspace()'s frontmostApplication()
set frontPid to frontApplication's processIdentifier() as integer
set frontName to frontApplication's localizedName() as text
set chromeState to ""
if application "Google Chrome" is running then
 tell application "Google Chrome"
  repeat with currentWindow in windows
   set chromeState to chromeState & (id of currentWindow as text) & ":" & (active tab index of currentWindow as text) & ","
  end repeat
 end tell
end if
return (frontPid as text) & "|" & frontName & "|" & chromeState`;
export async function ownerForeground({ includeChromeWindows = true } = {}) {
  if (process.platform !== 'darwin') return { status: 'unsupported' };
  try {
    const { stdout } = await execute(
      '/usr/bin/osascript',
      ['-e', includeChromeWindows ? SCRIPT : SCRIPT.replace(/if application [\s\S]*?end if/, '')],
      { timeout: 3000, maxBuffer: 8192 },
    );
    const [pid, applicationName, windows] = stdout.trim().split('|');
    if (!Number.isSafeInteger(Number(pid))) throw new Error('INVALID_FRONT_PID');
    return {
      status: 'observed',
      applicationPid: Number(pid),
      applicationName,
      chromeWindows: (windows ?? '').split(',').filter(Boolean).sort(),
    };
  } catch {
    return { status: 'unavailable' };
  }
}
