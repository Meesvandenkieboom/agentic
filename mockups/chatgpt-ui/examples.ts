import { mathExamples } from './math-examples';

/** Extra conversations for reviewing the real Markdown and KaTeX renderers. */
export const exampleChats = [
  {
    id: 'preview-markdown-guide', title: 'Markdown — headings, lists & quotes', hours: 0.1,
    prompt: 'Write a short implementation guide with different Markdown elements.',
    answer: String.raw`# Safer configuration changes

A configuration change should be **easy to review**, *easy to explain*, and reversible. Start with a small change and keep the defaults explicit.

## 1. Define the contract

The setting is called ` + '`historyLimit`' + String.raw`. It accepts a positive integer and defaults to **50**.

- **Input validation**
  - Reject negative numbers and fractional values.
  - Treat an omitted value as the default.
- **Persistence**
  - Save only after validation succeeds.
  - Keep the previous value if saving fails.

### Acceptance checklist

- [x] The default works without configuration.
- [x] Invalid input produces a useful error.
- [ ] Keyboard focus returns to the triggering control.
- [ ] The updated value survives a reload.

## 2. Explain the failure state

> **Unable to save settings**
>
> Your previous settings are still active. Check the value and try again.

Avoid vague messages such as ~~Something went wrong~~. Tell the user what happened and what they can do next.

---

### Review notes

1. Confirm the setting has one owner.
2. Check both the success and failure paths.
3. Review the rendered copy at a narrow window width.

For reference, [Markdown syntax](https://commonmark.org/help/) includes headings, links, emphasis, lists, and quotations.

**Ready when:** the setting changes predictably, and its failure state is understandable.`,
  },
  {
    id: 'preview-api-guide', title: 'Markdown — API docs & code', hours: 0.2,
    prompt: 'Document a paginated API with TypeScript, JSON, and an example request.',
    answer: String.raw`## List project files

Use ` + '`GET /api/files`' + String.raw` to request one page of results. The response includes a cursor only when another page is available.

### Parameters

| Name | Type | Default | Purpose |
| :--- | :--- | ---: | :--- |
| ` + '`limit`' + String.raw` | integer | 25 | Number of results, from 1 to 100 |
| ` + '`cursor`' + String.raw` | string | — | Continue from the previous page |
| ` + '`extension`' + String.raw` | string | — | Filter by file extension |

### Request

~~~bash
curl 'http://localhost:3002/api/files?limit=2&extension=ts'
~~~

This is an illustrative API contract; the UI preview does not implement this endpoint.

### Response

~~~json
{
  "files": [
    { "name": "cache.ts", "bytes": 1840 },
    { "name": "session.ts", "bytes": 3216 }
  ],
  "nextCursor": "page-2"
}
~~~

### Client types

~~~typescript
type FilePage = {
  files: Array<{ name: string; bytes: number }>;
  nextCursor: string | null;
};

async function loadPage(cursor?: string): Promise<FilePage> {
  const query = new URLSearchParams({ limit: '25' });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch('/api/files?' + query);
  if (!response.ok) throw new Error('Could not load files');
  return response.json();
}
~~~

> **Pagination rule:** request the next page using the returned cursor. Avoid deriving a cursor from the last filename.`,
  },
  {
    id: 'preview-review-notes', title: 'Markdown — review notes & diff', hours: 0.3,
    prompt: 'Show a realistic review comment with a diff, a checklist, and a comparison table.',
    answer: String.raw`The main issue is **sorting the shared array in place**. The sidebar and search results can receive the same array, so updating one view may unexpectedly reorder the other.

## Suggested change

~~~diff
 function recentFirst(sessions: Session[]) {
-  return sessions.sort(compareUpdatedAt);
+  return [...sessions].sort(compareUpdatedAt);
 }
~~~

### Behavior to verify

| Scenario | Before | After |
| --- | --- | --- |
| Sort recent chats | Mutates the input | Returns a new array |
| Open search | May inherit changed order | Keeps its original order |
| Empty history | Empty array | Empty array |

**The comparator stays the same.** Only the ownership of the sorted array changes.

### Checklist

- [x] Preserve the order of the caller's array.
- [x] Preserve the identities of the session objects.
- [ ] Add a regression case with equal timestamps.

> A shallow copy is sufficient here because sorting changes array positions, not the session objects themselves.

---

**Review status:** one small change requested. The existing naming and API can stay.`,
  },
  ...mathExamples,
];
