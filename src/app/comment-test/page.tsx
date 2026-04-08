"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Account = { id: string; name: string; isActive: boolean };

type Group = { id: string; name?: string; groupId: string; isActive: boolean };

type Post = {
  id: string;
  groupId: string;
  groupLabel: string;
  post_text: string;
  comment_link: string;
  status: string;
  rowIndex: number;
};

type CommentTestResponse = {
  success: boolean;
  message?: string;
  details?: string;
  error?: string;
  accountName?: string;
  groupLabel?: string;
  rowIndex?: number;
  postText?: string;
  commentLink?: string;
};

type Candidate = {
  index: number;
  score: number;
  articleText: string;
  storyText: string;
  hasActionsMenu: boolean;
  hasCommentControl: boolean;
};

type CandidatePreviewResponse = {
  candidates: Candidate[];
  rowIndex: number;
  postText: string;
  commentText: string;
  accountId: string;
  accountName: string;
  groupId: string;
  groupLabel: string;
};

function isCompletedPostStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "posted" || normalized === "done" || normalized === "completed" || normalized === "success";
}

export default function CommentTestPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [accountId, setAccountId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [rowIndex, setRowIndex] = useState<string>("");
  const [commentLink, setCommentLink] = useState("");
  const [visible, setVisible] = useState(true);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [result, setResult] = useState<CommentTestResponse | null>(null);
  const [preview, setPreview] = useState<CandidatePreviewResponse | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<string>("");

  async function loadData() {
    const [accountsRes, groupsRes, postsRes] = await Promise.all([
      fetch("/api/admin/fb-accounts"),
      fetch("/api/admin/fb-groups"),
      fetch("/api/admin/posts"),
    ]);

    const loadedAccounts = (await accountsRes.json()) as Account[];
    const loadedGroups = (await groupsRes.json()) as Group[];
    const loadedPosts = (await postsRes.json()) as Post[];

    setAccounts(loadedAccounts);
    setGroups(loadedGroups);
    setPosts(loadedPosts);

    if (!accountId && loadedAccounts.length > 0) {
      setAccountId(loadedAccounts[0].id);
    }

    if (!groupId && loadedGroups.length > 0) {
      setGroupId(loadedGroups[0].id);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  const activeGroups = useMemo(
    () => groups.filter((item) => item.isActive !== false),
    [groups]
  );

  const completedRows = useMemo(() => {
    return posts.filter((post) => post.groupId === groupId && isCompletedPostStatus(post.status));
  }, [posts, groupId]);

  const selectedPost = useMemo(() => {
    if (rowIndex) {
      return completedRows.find((post) => String(post.rowIndex) === rowIndex);
    }

    return completedRows.at(-1);
  }, [completedRows, rowIndex]);

  useEffect(() => {
    if (!rowIndex && selectedPost) {
      setCommentLink(selectedPost.comment_link || "");
    }
  }, [rowIndex, selectedPost]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setResult(null);

    try {
      const response = await fetch("/api/comment-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "run",
          accountId,
          groupId,
          rowIndex: rowIndex ? Number.parseInt(rowIndex, 10) : undefined,
          commentLink: commentLink.trim() || undefined,
          visible,
          articleIndex: selectedCandidate ? Number.parseInt(selectedCandidate, 10) : undefined,
        }),
      });

      const data = (await response.json()) as CommentTestResponse;
      setResult(data);
    } catch (error) {
      setResult({
        success: false,
        error: error instanceof Error ? error.message : "Network error while testing comment flow",
      });
    } finally {
      setLoading(false);
    }
  }

  async function handlePreviewCandidates() {
    setPreviewLoading(true);
    setResult(null);
    setPreview(null);

    try {
      const response = await fetch("/api/comment-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "inspect",
          accountId,
          groupId,
          rowIndex: rowIndex ? Number.parseInt(rowIndex, 10) : undefined,
          commentLink: commentLink.trim() || undefined,
          visible,
        }),
      });

      const data = (await response.json()) as CandidatePreviewResponse & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Failed to inspect candidates");
      }

      setPreview(data);
      setSelectedCandidate(data.candidates[0] ? String(data.candidates[0].index) : "");
    } catch (error) {
      setResult({
        success: false,
        error: error instanceof Error ? error.message : "Network error while inspecting candidates",
      });
    } finally {
      setPreviewLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_20%_20%,#1b3b48_0%,#07141c_42%,#03070c_100%)] px-4 py-8 sm:px-6 lg:px-10">
      <div className="mx-auto grid w-full max-w-6xl gap-6">
        <section className="rounded-3xl border border-[#275664] bg-[#071820d9] p-6 shadow-[0_24px_70px_rgba(0,0,0,0.35)] backdrop-blur">
          <p className="text-xs uppercase tracking-[0.2em] text-[#7de0e1]">Standalone Utility</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-[#effcff]">Comment Test Page</h1>
          <p className="mt-2 max-w-3xl text-sm text-[#a8c7cc]">
            Test the comment flow against an already completed post without creating a new post or consuming the publish loop.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 grid gap-4 lg:grid-cols-2">
            <label className="grid gap-2">
              <span className="text-sm font-semibold text-[#d8f0f2]">Account</span>
              <select
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                className="rounded-xl border border-[#325e67] bg-[#07131a] px-4 py-3 text-[#effcff] outline-none transition focus:border-[#7de0e1]"
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}{account.isActive ? "" : " (disabled)"}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-semibold text-[#d8f0f2]">Group</span>
              <select
                value={groupId}
                onChange={(event) => {
                  setGroupId(event.target.value);
                  setRowIndex("");
                }}
                className="rounded-xl border border-[#325e67] bg-[#07131a] px-4 py-3 text-[#effcff] outline-none transition focus:border-[#7de0e1]"
              >
                {activeGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name || group.groupId}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-semibold text-[#d8f0f2]">Completed Row</span>
              <select
                value={rowIndex}
                onChange={(event) => setRowIndex(event.target.value)}
                className="rounded-xl border border-[#325e67] bg-[#07131a] px-4 py-3 text-[#effcff] outline-none transition focus:border-[#7de0e1]"
              >
                <option value="">Latest completed row</option>
                {completedRows.map((post) => (
                  <option key={post.id} value={post.rowIndex}>
                    Row {post.rowIndex} - {post.status || "completed"}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-semibold text-[#d8f0f2]">Visible Browser</span>
              <button
                type="button"
                onClick={() => setVisible((prev) => !prev)}
                className={`rounded-xl border px-4 py-3 text-left text-sm font-semibold transition ${
                  visible
                    ? "border-[#4f9fa3] bg-[#0f2b31] text-[#d9ffff]"
                    : "border-[#325e67] bg-[#07131a] text-[#a8c7cc]"
                }`}
              >
                {visible ? "Enabled" : "Disabled"}
              </button>
            </label>

            <label className="grid gap-2 lg:col-span-2">
              <span className="text-sm font-semibold text-[#d8f0f2]">Comment Text</span>
              <textarea
                value={commentLink}
                onChange={(event) => setCommentLink(event.target.value)}
                placeholder="Leave empty to use the selected row's comment_link value"
                rows={4}
                className="w-full rounded-xl border border-[#325e67] bg-[#07131a] px-4 py-3 text-[#effcff] outline-none transition focus:border-[#7de0e1]"
              />
            </label>

            <div className="flex flex-wrap items-center gap-3 lg:col-span-2">
              <button
                type="submit"
                disabled={loading}
                className="rounded-xl bg-gradient-to-r from-[#0d9fb4] to-[#3dd7d0] px-6 py-3 font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? "Testing..." : "Run Comment Test"}
              </button>
              <button
                type="button"
                onClick={handlePreviewCandidates}
                disabled={previewLoading}
                className="rounded-xl border border-[#325e67] px-4 py-3 text-sm font-semibold text-[#d8f0f2] transition hover:bg-[#0a1e25] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {previewLoading ? "Loading..." : "Preview Candidates"}
              </button>
              <button
                type="button"
                onClick={() => {
                  const latest = completedRows.at(-1);
                  setRowIndex("");
                  setCommentLink(latest?.comment_link || "");
                }}
                className="rounded-xl border border-[#325e67] px-4 py-3 text-sm font-semibold text-[#d8f0f2] transition hover:bg-[#0a1e25]"
              >
                Load Latest Completed Row
              </button>
            </div>
          </form>
        </section>

        {preview ? (
          <section className="rounded-2xl border border-[#244d57] bg-[#07131ac7] p-5">
            <p className="text-sm font-semibold text-[#dff8f8]">Candidate Preview</p>
            <div className="mt-3 space-y-3 text-sm text-[#a9c8ca]">
              <p>
                Row {preview.rowIndex} on {preview.groupLabel} for {preview.accountName}
              </p>
              <p>Choose the card you want the comment test to use, then run the test.</p>
              <div className="grid gap-3">
                {preview.candidates.length > 0 ? (
                  preview.candidates.slice(0, 8).map((candidate) => (
                    <label
                      key={candidate.index}
                      className={`cursor-pointer rounded-xl border p-4 transition ${
                        selectedCandidate === String(candidate.index)
                          ? "border-[#7de0e1] bg-[#0f2b31]"
                          : "border-[#2d4d55] bg-[#09161d]"
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <input
                          type="radio"
                          name="candidate"
                          value={candidate.index}
                          checked={selectedCandidate === String(candidate.index)}
                          onChange={() => setSelectedCandidate(String(candidate.index))}
                          className="mt-1"
                        />
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="flex flex-wrap gap-2 text-xs uppercase tracking-wide text-[#8edede]">
                            <span>Index {candidate.index}</span>
                            <span>Score {candidate.score}</span>
                            {candidate.hasActionsMenu ? <span>Actions</span> : null}
                            {candidate.hasCommentControl ? <span>Comment control</span> : null}
                          </div>
                          <p className="break-words text-sm text-[#ebffff]">{candidate.articleText}</p>
                          {candidate.storyText ? (
                            <p className="break-words text-xs text-[#9fcacb]">Story: {candidate.storyText}</p>
                          ) : null}
                        </div>
                      </div>
                    </label>
                  ))
                ) : (
                  <p className="text-[#c9dadd]">No candidate cards were returned.</p>
                )}
              </div>
            </div>
          </section>
        ) : null}

        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-[#244d57] bg-[#07131ac7] p-5">
            <p className="text-sm font-semibold text-[#dff8f8]">Selection Preview</p>
            <div className="mt-3 space-y-2 text-sm text-[#a9c8ca]">
              <p>Account: {accounts.find((item) => item.id === accountId)?.name || "-"}</p>
              <p>Group: {groups.find((item) => item.id === groupId)?.name || groups.find((item) => item.id === groupId)?.groupId || "-"}</p>
              <p>Completed Rows: {completedRows.length}</p>
              <p>Selected Row: {selectedPost ? selectedPost.rowIndex : "Latest completed row"}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-[#244d57] bg-[#07131ac7] p-5">
            <p className="text-sm font-semibold text-[#dff8f8]">Result</p>
            {!result ? (
              <p className="mt-3 text-sm text-[#98b8bb]">Run a comment test to see the outcome here.</p>
            ) : result.success ? (
              <div className="mt-3 space-y-2 text-sm text-[#a8f4d1]">
                <p>Status: {result.message || "Success"}</p>
                <p>Account: {result.accountName}</p>
                <p>Group: {result.groupLabel}</p>
                <p>Row: {result.rowIndex}</p>
                <p>{result.details}</p>
              </div>
            ) : (
              <div className="mt-3 space-y-2 text-sm text-[#ffb1b1]">
                <p>Status: Failed</p>
                <p>{result.error || "Unknown error while testing comment flow."}</p>
              </div>
            )}
          </div>
        </section>

        {selectedPost ? (
          <section className="rounded-2xl border border-[#244d57] bg-[#07131ac7] p-5">
            <p className="text-sm font-semibold text-[#dff8f8]">Selected Completed Post</p>
            <div className="mt-3 space-y-2 text-sm text-[#a9c8ca]">
              <p>Row Index: {selectedPost.rowIndex}</p>
              <p>Status: {selectedPost.status}</p>
              <p>Comment Link: {selectedPost.comment_link || "-"}</p>
              <p className="break-words">Text: {selectedPost.post_text}</p>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}