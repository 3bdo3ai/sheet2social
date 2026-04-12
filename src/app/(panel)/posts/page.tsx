"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";

import { ModalShell } from "@/components/ui/modal-shell";

type Group = { id: string; name?: string; groupId: string };

type Post = {
  id: string;
  groupId: string;
  groupLabel: string;
  post_text: string;
  image_url: string;
  comment_link: string;
  status: string;
};

function normalizePostStatus(status: string): string {
  return status.trim().toLowerCase();
}

function isCompletedPostStatus(status: string): boolean {
  const normalized = normalizePostStatus(status);
  return normalized === "posted" || normalized === "done" || normalized === "completed" || normalized === "success";
}

function imageUrlPreview(url: string, maxLength = 84): string {
  const normalized = url.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}

export default function PostsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [open, setOpen] = useState(false);
  const [includeComment, setIncludeComment] = useState(false);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPostText, setEditPostText] = useState("");
  const [editImageUrl, setEditImageUrl] = useState("");
  const [editCommentLink, setEditCommentLink] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkGroupId, setBulkGroupId] = useState("");
  const [bulkFile, setBulkFile] = useState<File | null>(null);

  async function loadData() {
    const [groupsRes, postsRes] = await Promise.all([
      fetch("/api/admin/fb-groups"),
      fetch("/api/admin/posts"),
    ]);

    setGroups((await groupsRes.json()) as Group[]);
    setPosts((await postsRes.json()) as Post[]);
  }

  useEffect(() => {
    loadData();
  }, []);

  async function addPost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    form.set("addComment", String(includeComment));

    await fetch("/api/admin/posts", {
      method: "POST",
      body: form,
    });

    formElement.reset();
    setIncludeComment(false);
    setOpen(false);
    await loadData();
  }

  function startEdit(post: Post) {
    setEditingId(post.id);
    setEditPostText(post.post_text);
    setEditImageUrl(post.image_url || "");
    setEditCommentLink(post.comment_link || "");
    setEditStatus(post.status || "");
  }

  async function savePost(id: string) {
    await fetch("/api/admin/posts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        postText: editPostText,
        imageUrl: editImageUrl,
        commentLink: editCommentLink,
        status: editStatus,
      }),
    });

    setEditingId(null);
    await loadData();
  }

  async function deletePost(id: string) {
    await fetch("/api/admin/posts", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });

    await loadData();
  }

  async function duplicatePost(post: Post) {
    const form = new FormData();
    form.set("groupId", post.groupId);
    form.set("postText", post.post_text);
    form.set("imageUrl", post.image_url || "");
    form.set("addComment", String(Boolean(post.comment_link)));
    form.set("commentLink", post.comment_link || "");

    await fetch("/api/admin/posts", {
      method: "POST",
      body: form,
    });

    await loadData();
  }

  async function uploadBulkPosts(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!bulkGroupId || !bulkFile) {
      return;
    }

    const form = new FormData();
    form.set("action", "bulk");
    form.set("groupId", bulkGroupId);
    form.set("file", bulkFile);

    const response = await fetch("/api/admin/posts", {
      method: "POST",
      body: form,
    });

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      alert(payload.error || "Failed to import CSV");
      return;
    }

    setBulkOpen(false);
    setBulkGroupId("");
    setBulkFile(null);
    await loadData();
  }

  function downloadTemplate() {
    const content = [
      "post_text,image_url,comment_link,status",
      'Example post text,https://example.com/image.jpg,https://example.com/comment,',
    ].join("\n");

    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "posts-template.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  const normalizedSearch = search.trim().toLowerCase();
  const filteredPosts = posts.filter((post) => {
    const bySearch = normalizedSearch
      ? [post.groupLabel, post.post_text, post.image_url, post.comment_link, post.status]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearch)
      : true;
    const byGroup = groupFilter === "all" ? true : post.groupId === groupFilter;
    const postStatus = isCompletedPostStatus(post.status) ? "done" : normalizePostStatus(post.status) || "pending";
    const byStatus = statusFilter === "all" ? true : postStatus === statusFilter;
    return bySearch && byGroup && byStatus;
  });

  const withComments = posts.filter((post) => Boolean(post.comment_link)).length;
  const withImages = posts.filter((post) => Boolean(post.image_url)).length;
  const doneCount = posts.filter((post) => isCompletedPostStatus(post.status)).length;
  const pendingCount = posts.length - doneCount;

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="app-title">Posts Management</h1>
          <p className="app-subtitle">Create and manage your posts</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={downloadTemplate} className="btn-subtle rounded-xl px-4 py-3 text-sm font-semibold">
            Download Template
          </button>
          <button onClick={() => setBulkOpen(true)} className="btn-subtle rounded-xl px-4 py-3 text-sm font-semibold">
            Upload CSV
          </button>
          <button onClick={() => setOpen(true)} className="luxury-btn inline-flex items-center gap-2 rounded-xl px-5 py-3 font-semibold">
            <PlusIcon className="h-4 w-4" />
            Add Post
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <Metric title="Total Posts" value={posts.length} />
        <Metric title="Posts With Comment" value={withComments} />
        <Metric title="Posts With Image" value={withImages} />
        <Metric title="Done vs Pending" value={`${doneCount}/${pendingCount}`} />
      </div>

      <div className="app-card grid gap-3 p-4 md:grid-cols-[1.2fr_1fr_1fr]">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search caption, group, comment, or status"
          className="modal-input"
        />
        <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)} className="modal-input">
          <option value="all">All Groups</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name || group.groupId}
            </option>
          ))}
        </select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="modal-input">
          <option value="all">All Status</option>
          <option value="pending">Pending</option>
          <option value="done">Done</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      {posts.length === 0 ? (
        <div className="app-empty">
          <p className="text-xl">No posts yet</p>
          <button onClick={() => setOpen(true)} className="app-empty-action inline-flex items-center gap-2">
            <PlusIcon className="h-4 w-4" />
            Add Post
          </button>
        </div>
      ) : (
        <div className="app-table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th className="px-4 py-3">Group</th>
                <th className="px-4 py-3">Caption</th>
                <th className="px-4 py-3">Image URL</th>
                <th className="px-4 py-3">Comment</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredPosts.map((post) => (
                <tr key={post.id}>
                  <td className="px-4 py-3">{post.groupLabel}</td>
                  <td className="max-w-[360px] px-4 py-3">
                    {editingId === post.id ? (
                      <textarea
                        value={editPostText}
                        onChange={(event) => setEditPostText(event.target.value)}
                        rows={3}
                        className="modal-input"
                      />
                    ) : (
                      <p className="truncate">{post.post_text}</p>
                    )}
                  </td>
                  <td className="w-[280px] max-w-[280px] px-4 py-3">
                    {editingId === post.id ? (
                      <input
                        value={editImageUrl}
                        onChange={(event) => setEditImageUrl(event.target.value)}
                        className="modal-input"
                        placeholder="https://..."
                      />
                    ) : post.image_url ? (
                      <a
                        href={post.image_url}
                        target="_blank"
                        rel="noreferrer"
                        className="block max-w-[280px] truncate text-[#8fd0ff] underline-offset-2 hover:underline"
                        title={post.image_url}
                      >
                        {imageUrlPreview(post.image_url)}
                      </a>
                    ) : (
                      <p className="truncate">-</p>
                    )}
                  </td>
                  <td className="max-w-[280px] px-4 py-3">
                    {editingId === post.id ? (
                      <textarea
                        value={editCommentLink}
                        onChange={(event) => setEditCommentLink(event.target.value)}
                        rows={2}
                        className="modal-input"
                      />
                    ) : (
                      <p className="truncate">{post.comment_link || "-"}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {editingId === post.id ? (
                      <input
                        value={editStatus}
                        onChange={(event) => setEditStatus(event.target.value)}
                        className="modal-input"
                      />
                    ) : (
                      post.status || "Pending"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      {editingId === post.id ? (
                        <>
                          <button
                            onClick={() => savePost(post.id)}
                            className="btn-subtle text-xs"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="btn-subtle text-xs"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => startEdit(post)}
                          className="btn-subtle inline-flex items-center gap-1 text-xs"
                        >
                          <PencilSquareIcon className="h-3.5 w-3.5" />
                          Edit
                        </button>
                      )}
                      <button
                        onClick={() => duplicatePost(post)}
                        className="btn-subtle text-xs"
                      >
                        Duplicate
                      </button>
                      <button
                        onClick={() => deletePost(post.id)}
                        className="btn-subtle inline-flex items-center gap-1 text-xs text-[#ffc2cc]"
                      >
                        <TrashIcon className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredPosts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-[#9fb4d5]">
                    No posts match current filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      {open ? (
        <ModalShell className="max-w-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-2xl font-semibold">Add New Post</h2>
              <button onClick={() => setOpen(false)} className="btn-subtle inline-flex items-center justify-center">
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={addPost} className="grid gap-3">
              <label className="grid gap-1 text-sm">
                <span className="app-label">Group</span>
                <select name="groupId" required className="modal-input">
                  <option value="">Select group</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>{group.name || group.groupId}</option>
                  ))}
                </select>
              </label>

              <label className="grid gap-1 text-sm">
                <span className="app-label">Images (optional)</span>
                <input name="image" type="file" accept="image/*" className="modal-input" />
              </label>

              <label className="grid gap-1 text-sm">
                <span className="app-label">Image URL (optional)</span>
                <input name="imageUrl" type="url" placeholder="https://example.com/image.jpg" className="modal-input" />
              </label>

              <textarea name="postText" required rows={4} placeholder="Enter your post caption..." className="modal-input" />

              <label className="flex items-center gap-2 text-sm text-[#dceaff]">
                <input type="checkbox" checked={includeComment} onChange={(event) => setIncludeComment(event.target.checked)} />
                Add Comment After Posting
              </label>

              {includeComment ? (
                <textarea name="commentLink" rows={3} placeholder="Enter your comment..." className="modal-input" />
              ) : null}

              <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(false)} className="btn-subtle">Cancel</button>
                <button type="submit" className="luxury-btn rounded-lg px-4 py-2 font-semibold">Save Post</button>
              </div>
            </form>
        </ModalShell>
      ) : null}

      {bulkOpen ? (
        <ModalShell>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-2xl font-semibold">Bulk Upload Posts</h2>
              <button onClick={() => setBulkOpen(false)} className="btn-subtle inline-flex items-center justify-center">
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={uploadBulkPosts} className="grid gap-3">
              <label className="grid gap-1 text-sm">
                <span className="app-label">Target Group</span>
                <select
                  value={bulkGroupId}
                  onChange={(event) => setBulkGroupId(event.target.value)}
                  required
                  className="modal-input"
                >
                  <option value="">Select group</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>{group.name || group.groupId}</option>
                  ))}
                </select>
              </label>

              <label className="grid gap-1 text-sm">
                <span className="app-label">CSV File</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  required
                  onChange={(event) => setBulkFile(event.target.files?.[0] ?? null)}
                  className="modal-input"
                />
              </label>

              <p className="text-xs text-[#9fb4d5]">Required schema: post_text,image_url,comment_link,status</p>

              <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => setBulkOpen(false)} className="btn-subtle">Cancel</button>
                <button type="submit" className="luxury-btn rounded-lg px-4 py-2 font-semibold">Import CSV</button>
              </div>
            </form>
        </ModalShell>
      ) : null}
    </section>
  );
}

function Metric({ title, value }: { title: string; value: string | number }) {
  return (
    <div className="app-card p-4">
      <p className="text-sm text-[#acc0de]">{title}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}
