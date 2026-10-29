import { createHash } from "node:crypto";

export const hashBlob = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export class FakeGitHub {
  constructor() {
    this.repo = { id: 123, full_name: "test-owner/passport-data", private: true, visibility: "private",
      archived: false, permissions: { push: true }, default_branch: "main", html_url: "https://github.com/test-owner/passport-data" };
    this.blobs = new Map();
    this.trees = new Map();
    this.commits = new Map();
    this.calls = [];
    this.counter = 0;
    this.head = null;
    this.commitFiles({ "README.md": Buffer.from("Private passport data\n") });
  }

  sha() { return createHash("sha1").update(`fake-object-${++this.counter}`).digest("hex"); }
  addBlob(bytes) { const sha = hashBlob(bytes); this.blobs.set(sha, bytes); return sha; }
  tree() { return this.trees.get(this.commits.get(this.head).tree.sha); }
  read(path) { return this.blobs.get(this.tree().get(path)?.sha); }

  commitFiles(files) {
    const tree = this.head ? new Map(this.tree()) : new Map();
    for (const [path, bytes] of Object.entries(files)) {
      if (bytes === null) tree.delete(path);
      else tree.set(path, { path, sha: this.addBlob(bytes), mode: "100644", type: "blob", size: bytes.length });
    }
    const treeSha = this.sha(), commitSha = this.sha();
    this.trees.set(treeSha, tree);
    this.commits.set(commitSha, { sha: commitSha, tree: { sha: treeSha }, parents: this.head ? [this.head] : [] });
    this.head = commitSha;
  }

  request = async (method, path, body) => {
    this.calls.push({ method, path });
    await this.beforeRequest?.(method, path, body);
    const prefix = `repos/${this.repo.full_name}`;
    if (path === prefix && method === "GET") return { status: 200, data: structuredClone(this.repo) };
    const sub = path.slice(prefix.length);
    const ok = (data) => ({ status: 200, data });
    if (method === "GET" && sub === "/git/ref/heads/main") return ok({ object: { sha: this.head } });
    if (method === "GET" && sub.startsWith("/git/commits/")) return ok(this.commits.get(sub.split("/").pop()));
    if (method === "GET" && sub.startsWith("/git/trees/")) {
      const sha = sub.split("/").pop().split("?")[0];
      return ok({ tree: [...this.trees.get(sha).values()], truncated: false });
    }
    if (method === "GET" && sub.startsWith("/git/blobs/")) {
      const bytes = this.blobs.get(sub.split("/").pop());
      return ok({ encoding: "base64", content: bytes.toString("base64") });
    }
    if (method === "POST" && sub === "/git/blobs") {
      const bytes = Buffer.from(body.content, "base64");
      return ok({ sha: this.addBlob(bytes) });
    }
    if (method === "POST" && sub === "/git/trees") {
      const tree = new Map(this.trees.get(body.base_tree));
      for (const entry of body.tree) {
        if (entry.sha === null) tree.delete(entry.path);
        else tree.set(entry.path, { ...entry, size: this.blobs.get(entry.sha).length });
      }
      const sha = this.sha();
      this.trees.set(sha, tree);
      return ok({ sha });
    }
    if (method === "POST" && sub === "/git/commits") {
      const sha = this.sha();
      this.commits.set(sha, { sha, tree: { sha: body.tree }, parents: body.parents });
      return ok({ sha });
    }
    if (method === "PATCH" && sub === "/git/refs/heads/main") {
      if (body.force || this.commits.get(body.sha)?.parents[0] !== this.head) return { status: 422, data: {} };
      this.head = body.sha;
      return ok({ object: { sha: this.head } });
    }
    return { status: 404, data: { message: "Not Found" } };
  };
}
