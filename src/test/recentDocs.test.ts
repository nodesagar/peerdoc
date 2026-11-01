import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  formatTimeAgo,
  upsertRecentDocList,
  summarizeSnapshotWork,
  saveRecentDocs,
  loadRecentDocs,
  saveActiveDocSession,
  loadActiveDocSession,
  RECENT_DOCS_KEY,
  CACHE_SEEDED_KEY,
  RECENT_CACHE_NAME,
  resetRecentDocsMemoryForTest,
} from '../lib/recentDocs';
import { Dashboard } from '../components/Dashboard';
import { ProcessedDoc } from '../types';
import { DocumentSnapshot } from '../lib/crdt/schema';

const BASE_SNAPSHOT: DocumentSnapshot = {
  meta: { documentId: 'a'.repeat(64), title: 'Contract.pdf', createdAt: 1000 },
  pages: [
    { id: 'page-0', originalIndex: 0, order: 'a0', rotation: 0, deleted: false },
    { id: 'page-1', originalIndex: 1, order: 'a1', rotation: 0, deleted: false },
    { id: 'page-2', originalIndex: 2, order: 'a2', rotation: 0, deleted: false },
  ],
  textOverlays: [],
  whiteouts: [],
  redactions: [],
  signatures: [],
  annotations: [],
  comments: [],
  textEdits: [],
};

describe('Recent Documents tracking & browser-cache persistence', () => {
  beforeEach(() => {
    resetRecentDocsMemoryForTest();
  });

  it('upserts worked documents by documentId without duplicating and preserves prior edit action on reopen', () => {
    const docId = 'b'.repeat(64);
    const now = 1_700_000_000_000;

    let list: ProcessedDoc[] = [];
    list = upsertRecentDocList(
      list,
      {
        id: docId,
        documentId: docId,
        name: 'Agreement.pdf',
        action: 'Opened',
        size: '120 KB',
        timestamp: now - 60_000,
        timeAgo: '1m ago',
        format: 'pdf',
        pageCount: 4,
        tool: 'edit',
        details: '4 pages',
      },
      now
    );

    expect(list).toHaveLength(1);
    expect(list[0].action).toBe('Opened');
    expect(list[0].pageCount).toBe(4);

    // User modifies the document in Edit tool
    list = upsertRecentDocList(
      list,
      {
        id: docId,
        documentId: docId,
        name: 'Agreement.pdf',
        action: 'Edited',
        size: '120 KB',
        timestamp: now - 10_000,
        timeAgo: 'Just now',
        details: '4 pages • 2 text edits, 1 signature',
      },
      now
    );

    expect(list).toHaveLength(1);
    expect(list[0].action).toBe('Edited');
    expect(list[0].details).toBe('4 pages • 2 text edits, 1 signature');

    // Reopening the same document updates timestamp and keeps 'Edited' status
    list = upsertRecentDocList(
      list,
      {
        id: docId,
        documentId: docId,
        name: 'Agreement.pdf',
        action: 'Opened',
        size: '120 KB',
        timestamp: now,
        timeAgo: 'Just now',
      },
      now
    );

    expect(list).toHaveLength(1);
    expect(list[0].action).toBe('Edited');
    expect(list[0].details).toBe('4 pages • 2 text edits, 1 signature');
  });

  it('summarizes modifications across PDF and Word documents accurately', () => {
    const clean = summarizeSnapshotWork(BASE_SNAPSHOT, { activeTool: 'edit' });
    expect(clean.hasModifications).toBe(false);
    expect(clean.action).toBe('Opened');
    expect(clean.details).toBe('3 pages');
    expect(clean.pageCount).toBe(3);

    const editedSnapshot: DocumentSnapshot = {
      ...BASE_SNAPSHOT,
      textOverlays: [
        { id: 't1', pageIndex: 0, x: 10, y: 10, text: 'Hello', fontSize: 12 },
      ],
      signatures: [
        { id: 's1', pageIndex: 1, x: 20, y: 20, width: 20, height: 10, dataUrl: 'data:image/png;base64,AAA' },
      ],
      redactions: [
        { id: 'r1', pageIndex: 2, x: 5, y: 5, width: 15, height: 5 },
      ],
    };

    const edited = summarizeSnapshotWork(editedSnapshot, { activeTool: 'edit' });
    expect(edited.hasModifications).toBe(true);
    expect(edited.action).toBe('Edited');
    expect(edited.details).toContain('3 pages');
    expect(edited.details).toContain('1 text edit');
    expect(edited.details).toContain('1 redaction');
    expect(edited.details).toContain('1 signature');

    const wordSummary = summarizeSnapshotWork(BASE_SNAPSHOT, {
      isWordDoc: true,
      activeTool: 'edit',
      wordModified: true,
    });
    expect(wordSummary.hasModifications).toBe(true);
    expect(wordSummary.action).toBe('Edited');
    expect(wordSummary.details).toContain('Word document');
  });

  it('persists history across sessions and clears it when browser cache is erased', async () => {
    const store = new Map<string, Map<string, Response>>();
    const mockCaches = {
      open: vi.fn(async (name: string) => {
        if (!store.has(name)) store.set(name, new Map());
        const bucket = store.get(name)!;
        return {
          put: async (url: string, res: Response) => {
            bucket.set(url, res);
          },
        };
      }),
      has: vi.fn(async (name: string) => store.has(name)),
      delete: vi.fn(async (name: string) => store.delete(name)),
    };
    vi.stubGlobal('caches', mockCaches);

    const doc: ProcessedDoc = {
      id: 'c'.repeat(64),
      documentId: 'c'.repeat(64),
      name: 'Proposal.docx',
      action: 'Edited',
      size: '48 KB',
      timestamp: Date.now(),
      timeAgo: 'Just now',
      format: 'docx',
      tool: 'edit',
      details: 'Word document • Modified in editor',
    };

    await saveRecentDocs([doc]);

    // Reloading while browser cache is intact keeps the history
    const loadedBeforeClear = await loadRecentDocs();
    expect(loadedBeforeClear).toHaveLength(1);
    expect(loadedBeforeClear[0].name).toBe('Proposal.docx');
    expect(loadedBeforeClear[0].details).toBe('Word document • Modified in editor');

    // Simulate user erasing browser cache (Cache Storage deleted)
    store.delete(RECENT_CACHE_NAME);

    const loadedAfterCacheErase = await loadRecentDocs();
    expect(loadedAfterCacheErase).toEqual([]);

    vi.unstubAllGlobals();
  });

  it('persists the active document session across refreshes until explicitly saved/closed', async () => {
    const docId = 'e'.repeat(64);
    await saveActiveDocSession({
      documentId: docId,
      fileName: 'Syllabus.pdf',
      format: 'pdf',
    });

    const restored = await loadActiveDocSession();
    expect(restored).toEqual({
      documentId: docId,
      fileName: 'Syllabus.pdf',
      format: 'pdf',
    });

    // Ending the session (when Save is clicked) clears the active document session
    await saveActiveDocSession(null);
    expect(await loadActiveDocSession()).toBeNull();
  });

  it('renders worked document details inside the recent documents table without a manual Clear History button', () => {
    const docId = 'd'.repeat(64);
    const docs: ProcessedDoc[] = [
      {
        id: docId,
        documentId: docId,
        name: 'Quarterly_Report.pdf',
        action: 'Signed',
        size: '312.4 KB',
        timestamp: Date.now() - 120_000,
        timeAgo: '2m ago',
        format: 'pdf',
        pageCount: 6,
        tool: 'sign',
        details: '6 pages • 2 signatures',
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(Dashboard, {
        setActiveTool: () => {},
        recentDocs: docs,
        onSelectRecentDoc: () => {},
        onOpenRecentDoc: () => {},
        onLoadSample: () => {},
        onUploadNewDoc: () => {},
        onJoinRoomId: () => {},
        onNewWordDoc: () => {},
        activeDocId: docId,
      })
    );

    expect(html).toContain('<table');
    expect(html).toContain('Quarterly_Report.pdf');
    expect(html).toContain('Signed');
    expect(html).toContain('6 pages • 2 signatures');
    expect(html).toContain('312.4 KB');
    expect(html).toContain('dddddddd...');
    expect(html).toContain('Active');
    expect(html).not.toContain('Clear History');
  });

  it('formats relative time strings accurately', () => {
    const base = 1_700_000_000_000;
    expect(formatTimeAgo(base - 10_000, base)).toBe('Just now');
    expect(formatTimeAgo(base - 5 * 60_000, base)).toBe('5m ago');
    expect(formatTimeAgo(base - 3 * 3600_000, base)).toBe('3h ago');
    expect(formatTimeAgo(base - 24 * 3600_000, base)).toBe('Yesterday');
  });

  it('paginates recent documents table to 10 rows per page', () => {
    const docs: ProcessedDoc[] = Array.from({ length: 25 }, (_, i) => ({
      id: `doc-${i + 1}`,
      documentId: `doc-${i + 1}`,
      name: `Doc_${String(i + 1).padStart(2, '0')}.pdf`,
      action: 'Opened',
      size: '100 KB',
      timestamp: Date.now() - i * 1000,
      timeAgo: 'Just now',
      format: 'pdf',
      tool: 'edit',
    }));

    const html = renderToStaticMarkup(
      React.createElement(Dashboard, {
        setActiveTool: () => {},
        recentDocs: docs,
        onSelectRecentDoc: () => {},
        onOpenRecentDoc: () => {},
        onLoadSample: () => {},
        onUploadNewDoc: () => {},
        onJoinRoomId: () => {},
        onNewWordDoc: () => {},
        activeDocId: null,
      })
    );

    // Page 1 should contain Doc_01 through Doc_10
    expect(html).toContain('Doc_01.pdf');
    expect(html).toContain('Doc_10.pdf');
    // Page 1 should NOT contain Doc_11 through Doc_25
    expect(html).not.toContain('Doc_11.pdf');
    expect(html).not.toContain('Doc_25.pdf');

    // Should indicate showing 1-10 of 25 documents
    expect(html).toContain('Showing');
    expect(html).toContain('1</span>–<span class="font-semibold text-ink tabular-nums">10</span> of <span class="font-semibold text-ink tabular-nums">25</span> documents');

    // Should have pagination navigation
    expect(html).toContain('aria-label="Recent documents pagination"');
    expect(html).toContain('aria-label="Previous page"');
    expect(html).toContain('aria-label="Next page"');
  });
});
