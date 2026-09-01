# AGENTS.md

This repository is designed for long-running coding-agent work. The goal is not
to maximize raw code output. The goal is to leave the repo in a state where the
next session can continue without guessing.

## Startup Workflow

Before writing code:

1. Confirm the working directory with `pwd`.
2. Read `claude-progress.md` for the latest verified state and next step.
3. Read `feature_list.json` and choose the highest-priority unfinished feature.
4. Review recent commits with `git log --oneline -5`.
5. Run `.\init.ps1` (Windows PowerShell). 이 저장소의 표준 시작 경로다.
   외부 연결까지 건드릴 세션이면 `.\init.ps1 -Live` 로 시작한다 — 저장소 안의
   텍스트 검사만으로는 **"고쳤지만 배포를 잊은"** 상태를 잡을 수 없다.
6. Run the required smoke or end-to-end verification before starting new work.

If baseline verification is already failing, fix that first. Do not stack new
feature work on top of a broken starting state.

## Working Rules

- Work on one feature at a time.
- Do not mark a feature complete just because code was added.
- Keep changes within the selected feature scope unless a blocker forces a
  narrow supporting fix.
- Do not silently change verification rules during implementation.
- Prefer durable repo artifacts over chat summaries.

## Required Artifacts

- `feature_list.json`: source of truth for feature state
- `claude-progress.md`: session log and current verified status
- `init.ps1`: standard startup and verification path (Windows PowerShell 5.1 호환, UTF-8 **BOM** 필요)
- `session-handoff.md`: optional compact handoff for larger sessions
- `tools/check-report.py`: 저장된 상담 보고서가 끝까지 나왔는지 검사한다.
  보고서 산출 경로를 건드렸으면 **눈으로 보지 말고 이 명령으로 확인**한다.
- `.gitignore`: 실 프록시(`career_proxy.gs`)와 `local.endpoint.txt` 가 커밋되는 것을 막는다.
  이 두 항목을 지우지 말 것 — API 키와 배포 URL 이 들어간다.

## Definition Of Done

A feature is done only when all of the following are true:

- the target behavior is implemented
- the required verification actually ran
- evidence is recorded in `feature_list.json` or `claude-progress.md`
  (`init.ps1` 이 "근거 없는 passing" 을 실패로 처리한다 — 형식적 규칙이 아니다)
- the repository remains restartable from the standard startup path

## End Of Session

Before ending a session:

1. Update `claude-progress.md`.
2. Update `feature_list.json`.
3. Record any unresolved risk or blocker.
4. Commit with a descriptive message once the work is in a safe state.
5. Leave the repo clean enough for the next session to run `.\init.ps1`
   immediately.
