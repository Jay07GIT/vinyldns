/*
 * Copyright 2018 Comcast Cable Communications Management, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dnsChangeService } from "../../services/dnsChangeService";
import api from "../../services/api";
import type { DnsChange } from "../../types/dnsChange";

vi.mock("../../services/api", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  urlBuilder: vi.fn((path: string, params?: Record<string, unknown>) => {
    if (!params) return path;
    const query = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    return query ? `${path}?${query}` : path;
  }),
}));

const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

const BASE = "/dnschanges";

function buildChange(overrides: Partial<DnsChange> = {}): DnsChange {
  return {
    id: "batch-1",
    userId: "user-1",
    userName: "fbaggins",
    status: "Complete",
    comments: "",
    createdTimestamp: "2024-01-01T00:00:00Z",
    changes: [],
    ...overrides,
  } as DnsChange;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dnsChangeService", () => {
  describe("getBatchChange", () => {
    it("calls GET on the batch change resource", () => {
      mockApi.get.mockResolvedValueOnce({ data: buildChange() });
      dnsChangeService.getBatchChange("batch-1");
      expect(mockApi.get).toHaveBeenCalledWith(`${BASE}/batch-1`);
    });

    it("resolves with the change payload", async () => {
      mockApi.get.mockResolvedValueOnce({
        data: buildChange({ id: "batch-9" }),
      });
      const res = await dnsChangeService.getBatchChange("batch-9");
      expect(res.data.id).toBe("batch-9");
    });
  });

  describe("createBatchChange", () => {
    it("posts the change body to the base resource", () => {
      mockApi.post.mockResolvedValueOnce({ data: buildChange() });
      dnsChangeService.createBatchChange({ comments: "c", changes: [] });
      const [url, body] = mockApi.post.mock.calls[0];
      expect(url).toBe(BASE);
      expect(body).toEqual({ comments: "c", changes: [] });
    });

    it("appends allowManualReview when provided", () => {
      mockApi.post.mockResolvedValueOnce({ data: buildChange() });
      dnsChangeService.createBatchChange({ comments: "c", changes: [] }, true);
      const [url] = mockApi.post.mock.calls[0];
      expect(url).toContain("allowManualReview=true");
    });

    it("omits allowManualReview when undefined", () => {
      mockApi.post.mockResolvedValueOnce({ data: buildChange() });
      dnsChangeService.createBatchChange({ comments: "c", changes: [] });
      const [url] = mockApi.post.mock.calls[0];
      expect(url).not.toContain("allowManualReview");
    });
  });

  describe("getBatchChanges", () => {
    it("forwards paging and access params to the query string", () => {
      mockApi.get.mockResolvedValueOnce({ data: { batchChanges: [] } });
      dnsChangeService.getBatchChanges(50, 10, true);
      const [url] = mockApi.get.mock.calls[0];
      expect(url).toContain("maxItems=50");
      expect(url).toContain("startFrom=10");
      expect(url).toContain("ignoreAccess=true");
    });

    it("drops empty optional filters", () => {
      mockApi.get.mockResolvedValueOnce({ data: { batchChanges: [] } });
      dnsChangeService.getBatchChanges(50, undefined, false, "", "");
      const [url] = mockApi.get.mock.calls[0];
      expect(url).not.toContain("approvalStatus");
      expect(url).not.toContain("userName");
    });

    it("includes review filters when populated", () => {
      mockApi.get.mockResolvedValueOnce({ data: { batchChanges: [] } });
      dnsChangeService.getBatchChanges(
        50,
        0,
        true,
        "PendingReview",
        "fbaggins",
        "2024-01-01",
        "2024-02-01",
      );
      const [url] = mockApi.get.mock.calls[0];
      expect(url).toContain("approvalStatus=PendingReview");
      expect(url).toContain("userName=fbaggins");
      expect(url).toContain("dateTimeRangeStart=2024-01-01");
      expect(url).toContain("dateTimeRangeEnd=2024-02-01");
    });
  });

  describe("cancelBatchChange", () => {
    it("posts to the cancel sub-resource with an empty body", () => {
      mockApi.post.mockResolvedValueOnce({});
      dnsChangeService.cancelBatchChange("batch-1");
      expect(mockApi.post).toHaveBeenCalledWith(`${BASE}/batch-1/cancel`, {});
    });
  });

  describe("getBatchChangeCount", () => {
    it("calls the count resource with filters", () => {
      mockApi.get.mockResolvedValueOnce({ data: { total: 0 } });
      dnsChangeService.getBatchChangeCount(true, "PendingReview");
      const [url] = mockApi.get.mock.calls[0];
      expect(url).toContain(`${BASE}/count`);
      expect(url).toContain("ignoreAccess=true");
      expect(url).toContain("approvalStatus=PendingReview");
    });
  });

  describe("approveBatchChange", () => {
    it("posts a review comment when supplied", () => {
      mockApi.post.mockResolvedValueOnce({});
      dnsChangeService.approveBatchChange("batch-1", "looks good");
      expect(mockApi.post).toHaveBeenCalledWith(`${BASE}/batch-1/approve`, {
        reviewComment: "looks good",
      });
    });

    it("posts an empty body when no comment is supplied", () => {
      mockApi.post.mockResolvedValueOnce({});
      dnsChangeService.approveBatchChange("batch-1");
      expect(mockApi.post).toHaveBeenCalledWith(`${BASE}/batch-1/approve`, {});
    });
  });

  describe("rejectBatchChange", () => {
    it("posts a review comment when supplied", () => {
      mockApi.post.mockResolvedValueOnce({});
      dnsChangeService.rejectBatchChange("batch-1", "denied");
      expect(mockApi.post).toHaveBeenCalledWith(`${BASE}/batch-1/reject`, {
        reviewComment: "denied",
      });
    });

    it("posts an empty body when no comment is supplied", () => {
      mockApi.post.mockResolvedValueOnce({});
      dnsChangeService.rejectBatchChange("batch-1");
      expect(mockApi.post).toHaveBeenCalledWith(`${BASE}/batch-1/reject`, {});
    });
  });

  describe("exportToCsv", () => {
    let createObjectURL: ReturnType<typeof vi.fn>;
    let revokeObjectURL: ReturnType<typeof vi.fn>;
    let clickSpy: { mockRestore: () => void };

    beforeEach(() => {
      createObjectURL = vi.fn(() => "blob:mock") as ReturnType<typeof vi.fn>;
      revokeObjectURL = vi.fn();
      URL.createObjectURL =
        createObjectURL as unknown as typeof URL.createObjectURL;
      URL.revokeObjectURL =
        revokeObjectURL as unknown as typeof URL.revokeObjectURL;
      clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => {});
    });

    afterEach(() => {
      clickSpy.mockRestore();
    });

    it("creates and revokes an object URL for the download", () => {
      const change = buildChange({
        changes: [
          {
            changeType: "Add",
            inputName: "host.example.com.",
            type: "A",
            ttl: 300,
            status: "Complete",
          },
        ] as unknown as DnsChange["changes"],
      });

      dnsChangeService.exportToCsv(change);

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock");
    });

    it("builds a blob containing the header and a row per change", () => {
      const change = buildChange({
        changes: [
          {
            changeType: "Add",
            inputName: "host.example.com.",
            recordName: "host",
            zoneName: "example.com.",
            type: "A",
            record: { address: "1.2.3.4" },
            ttl: 300,
            status: "Complete",
          },
        ] as unknown as DnsChange["changes"],
      });

      let blobText = "";
      const originalBlob = global.Blob;
      global.Blob = class {
        constructor(parts: string[]) {
          blobText = parts.join("");
        }
      } as unknown as typeof Blob;

      dnsChangeService.exportToCsv(change);
      global.Blob = originalBlob;

      expect(blobText).toContain("Change Type,Input Name");
      expect(blobText).toContain("host.example.com.");
      expect(blobText).toContain("example.com.");
    });

    it("exports only the supplied rows when options.rows is provided", () => {
      const change = buildChange({
        changes: [
          {
            changeType: "Add",
            inputName: "a.example.com.",
            status: "Complete",
          },
          {
            changeType: "Add",
            inputName: "b.example.com.",
            status: "Complete",
          },
        ] as unknown as DnsChange["changes"],
      });

      let blobText = "";
      const originalBlob = global.Blob;
      global.Blob = class {
        constructor(parts: string[]) {
          blobText = parts.join("");
        }
      } as unknown as typeof Blob;

      dnsChangeService.exportToCsv(change, {
        rows: [change.changes[1]],
      });
      global.Blob = originalBlob;

      expect(blobText).toContain("b.example.com.");
      expect(blobText).not.toContain("a.example.com.");
    });

    it("escapes embedded quotes in record data", () => {
      const change = buildChange({
        changes: [
          {
            changeType: "Add",
            inputName: "txt.example.com.",
            type: "TXT",
            record: { text: 'say "hi"' },
            status: "Complete",
          },
        ] as unknown as DnsChange["changes"],
      });

      let blobText = "";
      const originalBlob = global.Blob;
      global.Blob = class {
        constructor(parts: string[]) {
          blobText = parts.join("");
        }
      } as unknown as typeof Blob;

      dnsChangeService.exportToCsv(change);
      global.Blob = originalBlob;

      // JSON-encoded record data has its quotes doubled by the CSV escaper
      expect(blobText).toContain('{""text"":');
    });

    it("tolerates a change with no changes array", () => {
      const change = buildChange({
        changes: undefined as unknown as DnsChange["changes"],
      });
      expect(() => dnsChangeService.exportToCsv(change)).not.toThrow();
    });
  });
});
