import { describe, expect, it } from "bun:test";
import listed from "../fixtures/gh/pr-list-branch.json";
import viewed from "../fixtures/gh/pr-view-open.json";
import { attentionRank } from "../../shared/pull-requests.ts";
import { ghRepo, toPullRequest, type Run } from "./gh.ts";

const answer = (code: number, stdout = "", stderr = ""): Run => async () => ({ code, stdout, stderr });

describe("gh pull requests", () => {
  it("reads a failing check, another repository and a requested review", () => {
    const pr = toPullRequest(viewed, "acme/api");
    expect(pr).toMatchObject({ number: 88, repo: "acme/client-sdk", own: false, state: "open", checks: "failing", review: "review_required", head: "feat/idem-key", base: "main", additions: 214, deletions: 38, merged_at: null });
    expect(pr.check_runs).toEqual([
      { name: "Fast checks", state: "passing", url: "https://github.com/acme/client-sdk/actions/runs/1" },
      { name: "Integration and browser", state: "failing", url: "https://github.com/acme/client-sdk/actions/runs/2" },
      { name: "coderabbit", state: "pending", url: null },
    ]);
  });

  it("reads a running check as pending, its own repository by name, and a draft", () => {
    const pr = toPullRequest(listed[0], "ACME/api");
    expect(pr).toMatchObject({ own: true, checks: "pending", review: "none" });
    expect(toPullRequest({ ...listed[0], isDraft: true }, "acme/api").state).toBe("draft");
    expect(toPullRequest({ ...listed[0], state: "MERGED", mergedAt: "2026-10-28T15:00:00Z" }, "acme/api").state).toBe("merged");
    expect(toPullRequest({ ...listed[0], statusCheckRollup: [] }, "acme/api").checks).toBe("none");
  });

  it("tells a missing gh, a signed-out gh and a folder with no GitHub remote apart", async () => {
    expect(await ghRepo(async () => null, "/w")).toEqual({ status: "missing", repo: null });
    expect(await ghRepo(answer(4, "", "To get started with GitHub CLI, please run:  gh auth login"), "/w")).toEqual({ status: "unauthenticated", repo: null });
    expect(await ghRepo(answer(1, "", "no git remotes found"), "/w")).toEqual({ status: "no_remote", repo: null });
    expect(await ghRepo(answer(0, '{"nameWithOwner":"acme/api"}'), "/w")).toEqual({ status: "ok", repo: "acme/api" });
  });

  it("reads a PR waiting on an assigned reviewer as a review requested, ranked so", () => {
    // the shape of zed-industries/zed#66227 as gh answered it: no decision, one pending reviewer, green checks
    const pr = toPullRequest({ ...listed[0], reviewDecision: "", reviewRequests: [{ __typename: "User", login: "dinocosta" }], statusCheckRollup: [{ __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }] }, "acme/api");
    expect([pr.review, pr.checks, attentionRank(pr)]).toEqual(["review_required", "passing", 2]);
    expect(toPullRequest({ ...listed[0], reviewDecision: "", reviewRequests: [] }, "acme/api").review).toBe("none");
  });

  it("counts a check run again by its newest run, as GitHub does", () => {
    // PR #9005's shape: the title linter cancelled at 09:56:50, then passed at 09:56:56
    const linter = (conclusion: string, startedAt: string) => ({ __typename: "CheckRun", name: "check-ticket-id", workflowName: "(Check) PR title linter", status: "COMPLETED", conclusion, startedAt, completedAt: startedAt });
    const rerun = toPullRequest({ ...listed[0], statusCheckRollup: [
      linter("CANCELLED", "2026-10-29T09:56:50Z"),
      { __typename: "CheckRun", name: "build", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-29T09:50:00Z" },
      linter("SUCCESS", "2026-10-29T09:56:56Z"),
    ] }, "acme/api");
    expect(rerun.checks).toBe("passing");
    expect(rerun.check_runs.map((run) => `${run.name} ${run.state}`)).toEqual(["check-ticket-id passing", "build passing"]);
    // a check whose newest run was cancelled still fails, as GitHub's merge box says
    expect(toPullRequest({ ...listed[0], statusCheckRollup: [linter("CANCELLED", "2026-10-29T09:56:50Z")] }, "acme/api").checks).toBe("failing");
  });
});
