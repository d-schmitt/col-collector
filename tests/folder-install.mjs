import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = ".github/extensions/col-collector";

export async function folderInstall() {
  const dir = await mkdtemp(join(tmpdir(), "col-folder-install-"));
  const extension = join(dir, "extensions", "col-collector");
  let runtime;
  try {
    // Model the distributed folder, never ignored postinstall output or a
    // developer's private artifacts. Include pending source changes before commit.
    const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", source], { cwd: root })
      .toString().split("\0").filter(Boolean);
    for (const file of files) {
      const destination = join(extension, relative(source, file));
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(root, file), destination);
    }
    const { createRuntime } = await import(pathToFileURL(join(extension, "runtime.mjs")).href);
    runtime = await createRuntime({ dataPath: join(dir, "private", "passport.sqlite") });
    const server = await runtime.open("folder-install");
    return {
      dir, extension, runtime, url: server.url,
      async dispose() {
        await runtime.dispose();
        await rm(dir, { recursive: true });
      },
    };
  } catch (error) {
    if (runtime) await runtime.dispose();
    await rm(dir, { recursive: true });
    throw error;
  }
}
