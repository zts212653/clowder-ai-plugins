import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Publish complete bytes once. A competing writer can never replace a retained original. */
export async function retainImageFile(dataPath: string, id: string, bytes: Buffer, assertCurrent: () => void | Promise<void>, conflict: string) {
    const directory = join(dataPath, 'images');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${id}.png`), temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const existing = await readFile(path);
        if (!existing.equals(bytes))
            throw new Error(conflict);
        return;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error;
    }
    try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await assertCurrent();
        try {
            await link(temporary, path);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                throw error;
            if (!(await readFile(path)).equals(bytes))
                throw new Error(conflict);
        }
    }
    finally {
        await rm(temporary, { force: true });
    }
}
