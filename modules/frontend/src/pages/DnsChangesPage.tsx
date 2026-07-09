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

import React, { useState, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { DnsChangesTable } from "../components/dnsChanges/DnsChangesTable";
import { DnsChangeForm } from "../components/dnsChanges/DnsChangeForm";
import { PaginatedSection } from "../components/common/Pagination";
import { LoadingSpinner } from "../components/common/LoadingSpinner";
import { useDnsChanges } from "../hooks/useDnsChanges";
import { useProfile } from "../contexts/ProfileContext";
import { useAlerts } from "../contexts/AlertContext";
import { dnsChangeService } from "../services/dnsChangeService";
import type {
  BatchChangeCount,
  DnsChangeSummary,
  CreateDnsChangeRequest,
} from "../types/dnsChange";
import type { PagingState } from "../types/common";

/**
 * DNS Changes page — lists batch change requests submitted to VinylDNS.
 *
 * Regular users see only their own requests. Super/support users get an
 * additional "All Requests" tab with extra filters (submitter, date range,
 * approval status). The two views reuse the same `useDnsChanges` hook by
 * toggling the `ignoreAccess` flag, which maps to the API's `ignoreAccess`
 * query parameter.
 */
export function DnsChangesPage() {
  const { profile } = useProfile();
  const location = useLocation();
  const savedState = location.state as {
    tab?: "my" | "all";
    paging?: PagingState;
  } | null;

  const canReview = Boolean(profile?.isSuper || profile?.isSupport);

  const [activeTab, setActiveTab] = useState<"my" | "all">(
    savedState?.tab ?? "my",
  );
  const ignoreAccess = activeTab === "all";

  const [submitterName, setSubmitterName] = useState("");
  const [approvalStatus, setApprovalStatus] = useState("");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");

  const {
    dnsChanges,
    isLoading,
    isFetching,
    refetch,
    nextPage,
    prevPage,
    nextPageEnabled,
    prevPageEnabled,
    getPanelTitle,
    cancelBatchChange,
    createBatchChange,
    isSubmitting,
    pageSize,
    setPageSize,
    pageSizes,
    currentPage,
    paging,
  } = useDnsChanges(
    ignoreAccess,
    ignoreAccess ? submitterName || undefined : undefined,
    approvalStatus || undefined,
    ignoreAccess ? dateStart || undefined : undefined,
    ignoreAccess ? dateEnd || undefined : undefined,
    savedState?.paging,
  );

  const { addAlert } = useAlerts();

  const handleCancel = (change: DnsChangeSummary) => {
    setCancelTarget(change);
  };

  const [cancelTarget, setCancelTarget] = useState<DnsChangeSummary | null>(
    null,
  );

  // ── New DNS Change modal state ────────────────────────────────────────────
  const [showNewModal, setShowNewModal] = useState(false);
  const [newModalRowErrors, setNewModalRowErrors] = useState<string[][]>([]);

  // Lock body scroll while the new-change modal is open.
  useEffect(() => {
    if (!showNewModal) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [showNewModal]);

  const handleNewChangeSubmit = (
    data: CreateDnsChangeRequest,
    allowManualReview: boolean,
  ) => {
    setNewModalRowErrors([]);
    createBatchChange(
      { data, allowManualReview },
      {
        onSuccess: () => {
          setShowNewModal(false);
          setNewModalRowErrors([]);
          void refetch();
        },
        onError: (err: unknown) => {
          const error = err as {
            response?: { status?: number; data?: unknown };
          };
          if (
            error.response?.status === 400 &&
            Array.isArray(error.response.data)
          ) {
            const perRow = (
              error.response.data as Array<{ errors?: string[] }>
            ).map((c) => c.errors ?? []);
            setNewModalRowErrors(perRow);
            if (perRow.some((e) => e.length > 0)) {
              addAlert(
                "danger",
                "Errors found in one or more rows. Please correct and resubmit.",
              );
            }
          }
        },
      },
    );
  };

  const handleConfirmCancel = () => {
    if (!cancelTarget) return;
    cancelBatchChange(cancelTarget.id);
    setCancelTarget(null);
  };

  // Dedicated count query — calls GET /dnschange/count which
  // uses SQL COUNT queries server-side. No page-size limit; returns exact
  // totals for all matching batch changes without fetching full records.
  const { data: countData, isLoading: isCountLoading } =
    useQuery<BatchChangeCount>({
      queryKey: [
        "dnschanges-count",
        ignoreAccess,
        ignoreAccess ? submitterName : undefined,
        approvalStatus,
        ignoreAccess ? dateStart : undefined,
        ignoreAccess ? dateEnd : undefined,
      ],
      queryFn: async () => {
        const res = await dnsChangeService.getBatchChangeCount(
          ignoreAccess,
          approvalStatus || undefined,
          ignoreAccess ? submitterName || undefined : undefined,
          ignoreAccess ? dateStart || undefined : undefined,
          ignoreAccess ? dateEnd || undefined : undefined,
        );
        return res.data;
      },
      retry: false, // don't retry on 404 (endpoint not yet deployed)
      staleTime: 120_000, // reuse cached counts for 2 min between navigations
      gcTime: 180_000, // keep in memory for 3 min after last subscriber
    });

  const currentUserId = profile?.id ?? "";

  const cardComplete = countData?.complete ?? 0;
  const cardFailed = countData?.failed ?? 0;
  const cardPartialFailure = countData?.partialFailure ?? 0;
  const cardRejected = countData?.rejected ?? 0;
  const cardCancelled = countData?.cancelled ?? 0;
  const cardPendingReview = countData?.pendingReview ?? 0;
  const cardScheduled = countData?.scheduled ?? 0;
  const cardPendingProcessing = countData?.pendingProcessing ?? 0;
  const cardTotal = countData?.total ?? 0;
  const cardPendingTotal =
    cardPendingReview + cardScheduled + cardPendingProcessing;
  const cardIssuesTotal = cardFailed + cardPartialFailure + cardRejected;
  const cardSuccessRate =
    cardTotal > 0 ? Math.round((cardComplete / cardTotal) * 100) : 0;
  const cardPendingPct =
    cardTotal > 0 ? Math.round((cardPendingTotal / cardTotal) * 100) : 0;
  const cardIssuesPct =
    cardTotal > 0 ? Math.round((cardIssuesTotal / cardTotal) * 100) : 0;

  const isCardsLoading = isCountLoading;

  const skeletonBlue = (
    <span className="vds-insight-skeleton vds-insight-skeleton--blue" />
  );
  const skeletonTeal = (
    <span className="vds-insight-skeleton vds-insight-skeleton--teal" />
  );
  const skeletonAmber = (
    <span className="vds-insight-skeleton vds-insight-skeleton--amber" />
  );
  const skeletonPurple = (
    <span className="vds-insight-skeleton vds-insight-skeleton--purple" />
  );

  return (
    <div>
      <div className="rounded-3 mb-4 d-flex justify-content-between align-items-center vds-page-header">
        <div className="d-flex align-items-center gap-3">
          <div className="rounded-3 d-flex align-items-center justify-content-center vds-page-header__icon">
            <i className="bi bi-list-ol text-white fs-5" />
          </div>
          <div>
            <h4 className="mb-0 fw-bold vds-page-header__title">DNS Changes</h4>
            <small className="text-muted">
              View and manage batch DNS change requests
            </small>
          </div>
        </div>
        <div className="d-flex align-items-center gap-2">
          <button
            type="button"
            className="btn btn-sm d-flex align-items-center gap-2 vds-btn-flat"
            onClick={() => void refetch()}
            title="Refresh DNS Changes"
          >
            <i className="bi bi-arrow-clockwise" />
            <span className="vds-btn-flat__label">Refresh</span>
          </button>
          <button
            type="button"
            className="btn btn-primary d-flex align-items-center gap-2 vds-btn-primary-shadow vds-btn-nav"
            onClick={() => {
              setNewModalRowErrors([]);
              setShowNewModal(true);
            }}
          >
            <i className="bi bi-plus-circle-fill" />
            New DNS Change
          </button>
        </div>
      </div>

      <div className="card mb-3 vds-toolbar-card">
        <div className="card-body py-2 px-3">
          <div className="d-flex gap-3 flex-wrap align-items-center">
            {canReview && (
              <div className="vds-pill-toggle">
                <button
                  type="button"
                  className={`vds-pill-toggle__btn${activeTab === "my" ? " vds-pill-toggle__btn--active" : ""}`}
                  onClick={() => setActiveTab("my")}
                >
                  <i className="bi bi-person-fill" />
                  My Requests
                </button>
                <button
                  type="button"
                  className={`vds-pill-toggle__btn${activeTab === "all" ? " vds-pill-toggle__btn--active" : ""}`}
                  onClick={() => setActiveTab("all")}
                >
                  <i className="bi bi-people-fill" />
                  All Requests
                </button>
              </div>
            )}

            <label
              className="d-flex align-items-center gap-2 mb-0 vds-toggle-label"
              htmlFor="pendingReviewSwitch"
              style={{ cursor: "pointer", userSelect: "none" }}
            >
              <input
                type="checkbox"
                id="pendingReviewSwitch"
                className="form-check-input"
                checked={approvalStatus === "PendingReview"}
                onChange={(e) =>
                  setApprovalStatus(e.target.checked ? "PendingReview" : "")
                }
                style={{
                  width: 36,
                  height: 20,
                  cursor: "pointer",
                  accentColor: "#1e5fa8",
                }}
              />
              <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>
                Open Requests Only
              </span>
              {approvalStatus === "PendingReview" && (
                <span
                  className="badge d-inline-flex align-items-center gap-1"
                  style={{
                    background: "linear-gradient(90deg, #b7770d, #9a6109)",
                    color: "#fff",
                    fontSize: "0.7rem",
                    borderRadius: 20,
                    padding: "0.25em 0.7em",
                    fontWeight: 700,
                  }}
                >
                  <i
                    className="bi bi-hourglass-split"
                    style={{ fontSize: "0.62rem" }}
                  />
                  Pending Review
                </span>
              )}
            </label>
          </div>

          {ignoreAccess && (
            <div className="mt-2 pt-2 border-top">
              <div className="row g-2 align-items-end">
                <div className="col-12 col-md-4">
                  <label
                    className="form-label mb-1 small fw-semibold text-muted text-uppercase"
                    style={{ letterSpacing: "0.06em", fontSize: "0.7rem" }}
                  >
                    <i className="bi bi-person-search me-1" />
                    Submitter
                  </label>
                  <div className="input-group input-group-sm vds-search-group">
                    <span className="input-group-text border-0 bg-transparent pe-1">
                      <i className="bi bi-person text-muted" />
                    </span>
                    <input
                      type="text"
                      className="form-control border-0 ps-0 shadow-none bg-transparent"
                      placeholder="Search by username"
                      value={submitterName}
                      onChange={(e) => setSubmitterName(e.target.value)}
                    />
                  </div>
                </div>

                <div className="col-12 col-md-3">
                  <label
                    className="form-label mb-1 small fw-semibold text-muted text-uppercase"
                    style={{ letterSpacing: "0.06em", fontSize: "0.7rem" }}
                  >
                    <i className="bi bi-calendar-event me-1" />
                    From Date
                  </label>
                  <input
                    type="datetime-local"
                    className="form-control form-control-sm"
                    value={dateStart}
                    onChange={(e) => setDateStart(e.target.value)}
                  />
                </div>

                <div className="col-12 col-md-3">
                  <label
                    className="form-label mb-1 small fw-semibold text-muted text-uppercase"
                    style={{ letterSpacing: "0.06em", fontSize: "0.7rem" }}
                  >
                    <i className="bi bi-calendar-check me-1" />
                    To Date
                  </label>
                  <input
                    type="datetime-local"
                    className="form-control form-control-sm"
                    value={dateEnd}
                    onChange={(e) => setDateEnd(e.target.value)}
                  />
                </div>

                <div className="col-12 col-md-2">
                  <button
                    type="button"
                    className="btn btn-sm w-100 d-flex align-items-center justify-content-center gap-1 vds-btn-flat"
                    onClick={() => {
                      setSubmitterName("");
                      setDateStart("");
                      setDateEnd("");
                    }}
                  >
                    <i className="bi bi-arrow-counterclockwise" />
                    <span className="vds-btn-flat__label">Reset</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Insight cards ── */}
      <div className="row g-2 mb-3 align-items-stretch">
        {/* Card 1: Total Requests */}
        <div className="col-6 col-sm-4 col-xl d-flex">
          <div className="rounded-3 px-3 py-1 w-100 d-flex flex-column vds-insight-card vds-insight-card--blue">
            <div className="d-flex align-items-center gap-2 mb-1">
              <div className="rounded-2 vds-insight-icon vds-insight-icon--blue">
                <i className="bi bi-list-ol" />
              </div>
              <span className="vds-insight-label vds-insight-label--blue">
                Requests
                <span className="vds-card-ctx-chip vds-card-ctx-chip--blue ms-1">
                  {ignoreAccess ? "All" : "Mine"}
                </span>
              </span>
              <span className="vds-insight-value vds-insight-value--blue">
                {isCardsLoading ? skeletonBlue : cardTotal}
              </span>
            </div>
            <div
              className="vds-insight-body vds-insight-body--blue"
              style={{ rowGap: 6 }}
            >
              <div className="vds-insight-stat-label">Issues</div>
              <div className="vds-insight-stat-label vds-insight-stat-label--right">
                Pending
              </div>
              <div className="vds-insight-stat-value vds-insight-stat-value--blue">
                {isCardsLoading ? "…" : cardIssuesTotal}
              </div>
              <div className="vds-insight-stat-value vds-insight-stat-value--blue vds-insight-stat-value--right">
                {isCardsLoading ? "…" : cardPendingTotal}
              </div>
              <div
                className="vds-insight-footnote"
                style={{ gridColumn: "1 / -1" }}
              >
                <i className="bi bi-check2-circle me-1 vds-icon-blue-dim" />
                {isCardsLoading
                  ? "…"
                  : `${cardSuccessRate}% success rate · ${cardComplete} complete`}
              </div>
            </div>
          </div>
        </div>

        {/* Card 2: Complete */}
        <div className="col-6 col-sm-4 col-xl d-flex">
          <div className="rounded-3 px-3 py-1 w-100 d-flex flex-column vds-insight-card vds-insight-card--teal">
            <div className="d-flex align-items-center gap-2 mb-1">
              <div className="rounded-2 vds-insight-icon vds-insight-icon--teal">
                <i className="bi bi-check-circle-fill" />
              </div>
              <span className="vds-insight-label vds-insight-label--teal">
                Complete
              </span>
              <span className="vds-insight-value vds-insight-value--teal">
                {isCardsLoading ? skeletonTeal : cardComplete}
              </span>
            </div>
            {!isCardsLoading && cardTotal > 0 ? (
              <>
                <div
                  className="vds-insight-progress vds-insight-progress--teal"
                  style={{ height: 6, marginBottom: 2 }}
                >
                  <div
                    className="vds-insight-progress__fill vds-insight-progress__fill--teal"
                    style={{ width: `${cardSuccessRate}%` }}
                  />
                </div>
                <div
                  style={{
                    fontSize: "0.67rem",
                    color: "#0ca678",
                    fontWeight: 700,
                    marginBottom: 3,
                  }}
                >
                  {cardSuccessRate}%{" "}
                  <span style={{ fontWeight: 400, color: "#8099b8" }}>
                    of all requests
                  </span>
                </div>
              </>
            ) : (
              <div style={{ height: 4 }} />
            )}
            <div className="vds-insight-body vds-insight-body--teal">
              <div className="vds-insight-stat-label">Cancelled</div>
              <div className="vds-insight-stat-label vds-insight-stat-label--right">
                Rate
              </div>
              <div className="vds-insight-stat-value vds-insight-stat-value--teal">
                {isCardsLoading ? "…" : cardCancelled}
              </div>
              <div className="vds-insight-stat-value vds-insight-stat-value--teal vds-insight-stat-value--right">
                {isCardsLoading ? "…" : `${cardSuccessRate}%`}
              </div>
            </div>
          </div>
        </div>

        {/* Card 3: Pending */}
        <div className="col-6 col-sm-4 col-xl d-flex">
          <div className="rounded-3 px-3 py-1 w-100 d-flex flex-column vds-insight-card vds-insight-card--amber">
            <div className="d-flex align-items-center gap-2 mb-1">
              <div className="rounded-2 vds-insight-icon vds-insight-icon--amber">
                <i className="bi bi-hourglass-split" />
              </div>
              <span className="vds-insight-label vds-insight-label--amber">
                Pending
              </span>
              <span className="vds-insight-value vds-insight-value--amber">
                {isCardsLoading ? skeletonAmber : cardPendingTotal}
              </span>
            </div>
            <div
              className="vds-insight-body vds-insight-body--amber"
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div className="vds-insight-stat-label">Review</div>
                  <div className="vds-insight-stat-value vds-insight-stat-value--amber">
                    {isCardsLoading ? "…" : cardPendingReview}
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <div className="vds-insight-stat-label">Scheduled</div>
                  <div className="vds-insight-stat-value vds-insight-stat-value--amber">
                    {isCardsLoading ? "…" : cardScheduled}
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <div className="vds-insight-stat-label">Processing</div>
                  <div className="vds-insight-stat-value vds-insight-stat-value--amber">
                    {isCardsLoading ? "…" : cardPendingProcessing}
                  </div>
                </div>
              </div>
              <div className="vds-insight-footnote">
                <i className="bi bi-hourglass-split me-1 vds-icon-amber" />
                {isCardsLoading
                  ? "…"
                  : cardPendingTotal > 0
                    ? `${cardPendingTotal} request${cardPendingTotal === 1 ? "" : "s"} awaiting action`
                    : "No pending requests"}
              </div>
            </div>
          </div>
        </div>

        {/* Card 4: Issues */}
        <div className="col-6 col-sm-4 col-xl d-flex">
          <div className="rounded-3 px-3 py-1 w-100 d-flex flex-column vds-insight-card vds-insight-card--purple">
            <div className="d-flex align-items-center gap-2 mb-1">
              <div className="rounded-2 vds-insight-icon vds-insight-icon--purple">
                <i className="bi bi-exclamation-triangle-fill" />
              </div>
              <span className="vds-insight-label vds-insight-label--purple">
                Issues
              </span>
              <span className="vds-insight-value vds-insight-value--purple">
                {isCardsLoading ? skeletonPurple : cardIssuesTotal}
              </span>
            </div>
            <div
              className="vds-insight-body vds-insight-body--purple"
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div className="vds-insight-stat-label">Failed</div>
                  <div className="vds-insight-stat-value vds-insight-stat-value--purple">
                    {isCardsLoading ? "…" : cardFailed}
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <div className="vds-insight-stat-label">Partial</div>
                  <div className="vds-insight-stat-value vds-insight-stat-value--purple">
                    {isCardsLoading ? "…" : cardPartialFailure}
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <div className="vds-insight-stat-label">Rejected</div>
                  <div className="vds-insight-stat-value vds-insight-stat-value--purple">
                    {isCardsLoading ? "…" : cardRejected}
                  </div>
                </div>
              </div>
              <div className="vds-insight-footnote">
                <i className="bi bi-exclamation-circle me-1 vds-icon-purple-dim" />
                {isCardsLoading
                  ? "…"
                  : cardIssuesTotal > 0
                    ? `${cardIssuesTotal} request${cardIssuesTotal === 1 ? "" : "s"} need attention`
                    : "No issues"}
              </div>
            </div>
          </div>
        </div>
      </div>

      {isLoading || isFetching ? (
        <LoadingSpinner message="Loading changes…" />
      ) : (
        <PaginatedSection
          show={prevPageEnabled || nextPageEnabled}
          onPrev={prevPage}
          onNext={nextPage}
          prevEnabled={prevPageEnabled}
          nextEnabled={nextPageEnabled}
          rangeLabel={
            dnsChanges.length > 0
              ? `${(currentPage - 1) * pageSize + 1}–${(currentPage - 1) * pageSize + dnsChanges.length}`
              : undefined
          }
          totalCount={cardTotal > 0 ? cardTotal : undefined}
        >
          <DnsChangesTable
            changes={dnsChanges}
            onCancel={handleCancel}
            ignoreAccess={ignoreAccess}
            currentUserId={currentUserId}
            fromTab={activeTab}
            currentPaging={paging}
          />
        </PaginatedSection>
      )}
      {cancelTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="list-cancel-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCancelTarget(null);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.65)",
            backdropFilter: "blur(3px)",
            zIndex: 1080,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1.5rem",
          }}
        >
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e8ecf0",
              borderRadius: "0.85rem",
              boxShadow: "0 25px 60px rgba(0,0,0,0.4)",
              width: "min(460px, 100%)",
              overflow: "hidden",
            }}
          >
            {/* Header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.85rem",
                padding: "1.1rem 1.4rem",
                borderBottom: "1px solid #e8ecf0",
                background: "linear-gradient(90deg,#ffffff,#f8fafd)",
              }}
            >
              <span
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: "50%",
                  background: "#fff7e0",
                  color: "#d97706",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "1.05rem",
                  flexShrink: 0,
                }}
              >
                <i className="bi bi-exclamation-triangle-fill" />
              </span>
              <div style={{ flex: 1 }}>
                <h6
                  id="list-cancel-modal-title"
                  style={{
                    margin: 0,
                    fontSize: "1rem",
                    fontWeight: 700,
                    color: "#0d1b3e",
                  }}
                >
                  Cancel DNS Change
                </h6>
                <div
                  style={{
                    marginTop: 2,
                    fontSize: "0.75rem",
                    color: "#64748b",
                  }}
                >
                  This action cannot be undone
                </div>
              </div>
              <button
                type="button"
                onClick={() => setCancelTarget(null)}
                aria-label="Close"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#64748b",
                  fontSize: "1rem",
                  cursor: "pointer",
                  padding: "0.25rem 0.5rem",
                  borderRadius: "0.4rem",
                }}
              >
                <i className="bi bi-x-lg" />
              </button>
            </div>

            {/* Body */}
            <div
              style={{
                padding: "1.25rem 1.4rem",
                fontSize: "0.9rem",
                color: "#334155",
                lineHeight: 1.6,
              }}
            >
              Are you sure you want to cancel this DNS Change?
              <div
                style={{
                  marginTop: "0.75rem",
                  padding: "0.6rem 0.85rem",
                  background: "#f8fafd",
                  border: "1px solid #e2e8f0",
                  borderRadius: "0.5rem",
                  fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace",
                  fontSize: "0.78rem",
                  color: "#1e5fa8",
                  wordBreak: "break-all",
                }}
              >
                {cancelTarget.id}
              </div>
            </div>

            {/* Footer */}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "0.6rem",
                padding: "0.9rem 1.4rem",
                borderTop: "1px solid #e8ecf0",
                background: "#f8fafd",
              }}
            >
              <button
                type="button"
                onClick={() => setCancelTarget(null)}
                style={{
                  padding: "0.5rem 1.1rem",
                  background: "transparent",
                  border: "1px solid #d4dbe8",
                  color: "#334155",
                  borderRadius: "0.5rem",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                  fontWeight: 500,
                }}
              >
                Decline
              </button>
              <button
                type="button"
                onClick={handleConfirmCancel}
                style={{
                  padding: "0.5rem 1.25rem",
                  background: "linear-gradient(135deg,#f59e0b,#d97706)",
                  border: "none",
                  color: "#fff",
                  borderRadius: "0.5rem",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  boxShadow: "0 4px 12px rgba(245,158,11,0.35)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <i className="bi bi-check2" />
                Confirm Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── New DNS Change modal ──────────────────────────────────────────── */}
      {showNewModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-change-modal-title"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.65)",
            backdropFilter: "blur(3px)",
            zIndex: 1080,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !isSubmitting)
              setShowNewModal(false);
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "0.85rem",
              boxShadow: "0 25px 60px rgba(0,0,0,0.4)",
              width: "min(1100px, 100%)",
              maxHeight: "92vh",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {/* Modal header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.85rem",
                padding: "1rem 1.4rem",
                borderBottom: "1px solid #e8ecf0",
                background: "linear-gradient(90deg, #f0f4fa, #ffffff)",
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  background: "linear-gradient(135deg, #1e5fa8, #0d1b3e)",
                  boxShadow: "0 4px 12px rgba(13,27,62,0.35)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <i className="bi bi-plus-circle-fill text-white fs-6" />
              </div>
              <div style={{ flex: 1 }}>
                <h5
                  id="new-change-modal-title"
                  style={{
                    margin: 0,
                    fontWeight: 700,
                    fontSize: "1rem",
                    color: "#0d1b3e",
                  }}
                >
                  New Batch Change
                </h5>
                <small style={{ color: "#64748b" }}>
                  Submit a new DNS batch change request for review and
                  processing
                </small>
              </div>
              {isSubmitting && (
                <span className="d-flex align-items-center gap-2 small text-muted me-2">
                  <span
                    className="spinner-border spinner-border-sm"
                    role="status"
                  />
                  Submitting…
                </span>
              )}
              <button
                type="button"
                aria-label="Close"
                disabled={isSubmitting}
                onClick={() => setShowNewModal(false)}
                className="rhm-header-btn"
              >
                <i className="bi bi-x-lg rhm-close-icon" />
              </button>
            </div>

            {/* Modal body — scrollable */}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "1.25rem 1.4rem",
              }}
            >
              <DnsChangeForm
                onSubmit={handleNewChangeSubmit}
                onCancel={() => setShowNewModal(false)}
                isSubmitting={isSubmitting}
                serverRowErrors={newModalRowErrors}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
