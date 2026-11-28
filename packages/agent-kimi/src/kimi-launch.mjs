const RESERVED_VALUE_REQUIRED = new Set([
    '--agent-file',
    '--agent'
]);
const RESERVED_VALUE_OPTIONAL = new Set([
    '--session',
    '-S'
]);
const RESERVED_VALUE_NONE = new Set([
    '--continue',
    '-c'
]);
const RESERVED_ATTACHED_VALUE = /^(?:--agent-file=|--agent=|--session=|-S=|-S(?=.))/;
export function stripReservedKimiSystemArgs(userParts) {
    const out = [];
    for(let i = 0; i < userParts.length; i++){
        const part = userParts[i];
        if (RESERVED_VALUE_REQUIRED.has(part)) {
            i++;
            continue;
        }
        if (RESERVED_VALUE_OPTIONAL.has(part)) {
            const next = userParts[i + 1];
            if (next !== undefined && !next.startsWith('-')) i++;
            continue;
        }
        if (RESERVED_VALUE_NONE.has(part)) continue;
        if (RESERVED_ATTACHED_VALUE.test(part)) continue;
        out.push(part);
    }
    return out;
}
export function buildKimiLaunchArguments(input) {
    const args = [
        '--output-format',
        'stream-json'
    ];
    if (input.skillsDirectory) args.push('--skills-dir', input.skillsDirectory);
    const managedArgvFlags = [];
    if (input.resumeSessionId) args.push('--session', input.resumeSessionId);
    for (const dir of input.imageAccessDirs)args.push('--add-dir', dir);
    if (input.model) {
        args.push('--model', input.model);
    }
    if (input.agentFile) {
        args.push('--agent-file', input.agentFile);
        managedArgvFlags.push('--agent-file');
    }
    args.push('-p', input.prompt);
    const userParts = stripReservedKimiSystemArgs(input.cliConfigArgs?.flatMap((arg)=>arg.trim().split(/\s+/)) ?? []);
    if (userParts.length > 0) {
        const accumulativeFlags = new Set([
            '--add-dir'
        ]);
        const userFlags = new Set(userParts.filter((p)=>p.startsWith('-')));
        const deduped = [];
        for(let i = 0; i < args.length; i++){
            if (args[i].startsWith('-') && userFlags.has(args[i]) && !accumulativeFlags.has(args[i])) {
                if (i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
                continue;
            }
            deduped.push(args[i]);
        }
        args.length = 0;
        args.push(...deduped, ...userParts);
    }
    return {
        args,
        managedArgvFlags
    };
}
