#!/usr/bin/env bash
# Scenario 40 — distill lane end-to-end in a real dsh process (keyless):
#   - fixture carries TWO model scripts: call 1 = the main agent's answer,
#     call 2 = a distill-lane ops JSON (create one Topic)
#   - llmwiki.distillEveryTurns=1 so the turn/end trigger fires inside the
#     one-shot session; replay answers in-process, so the lane wins the
#     exit race deterministically
#   - assert: the distilled topic file lands in the bundle with a commit
set -euo pipefail

export DSH_HOME=/root/.dsh-e2e
P="$DSH_HOME/profiles/e2e"
B="$DSH_HOME/llmwiki"

: "${DSH_VERSION:=$(npm view @deepseek-ai/dsh version)}"

echo '==> configuring distill route (replay provider) + every-turn cadence'
cat > "$DSH_HOME/settings.yaml" <<'EOF'
agent-default-model:
  provider: replay
  model: replay-1
llmwiki:
  distillProvider: replay
  distillModel: replay-1
  distillEveryTurns: 1
EOF

echo '==> writing the two-call replay fixture (answer + distill ops)'
F=/tmp/replay-fixture-distill
mkdir -p "$F"
TS=$(date +%s000)
OPS='{"ops":[{"op":"create","title":"项目优先级：dsh-cron 对比 pi-tui","description":"两条产品线的先后排序","tags":["优先级","dsh"],"depends":[],"open_questions":["外部阻塞何时解除"],"impact":["发布节奏"],"conclusion":"先做 dsh-cron：它有明确的外部依赖窗口，错过就要再等一个周期。","recommendations":"本周内排期 dsh-cron 的窗口适配。","status":"draft"}]}'
cat > "$F/session.jsonl" <<EOF
{"type":"session","version":0,"id":"fixture-distill-1","createdAt":$TS,"cwd":"/tmp","delegationDepth":0}
{"type":"assistant/chunk","seq":1,"time":$TS,"data":{"turn":1,"step":1,"chunk":{"type":"block-start","index":0,"blockType":"text"}}}
{"type":"assistant/chunk","seq":2,"time":$TS,"data":{"turn":1,"step":1,"chunk":{"type":"text-delta","index":0,"text":"好的，收到。"}}}
{"type":"assistant/chunk","seq":3,"time":$TS,"data":{"turn":1,"step":1,"chunk":{"type":"block-end","index":0,"block":{"type":"text","text":"好的，收到。"}}}}
{"type":"assistant/chunk","seq":4,"time":$TS,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":100,"outputTokens":10,"cacheReadTokens":0,"reasoningTokens":0}}}}
{"type":"assistant/chunk","seq":5,"time":$TS,"data":{"turn":1,"step":1,"chunk":{"type":"finish","reason":{"kind":"stop"}}}}
{"type":"assistant/chunk","seq":6,"time":$TS,"data":{"turn":2,"step":1,"chunk":{"type":"block-start","index":0,"blockType":"text"}}}
{"type":"assistant/chunk","seq":7,"time":$TS,"data":{"turn":2,"step":1,"chunk":{"type":"text-delta","index":0,"text":$(printf '%s' "$OPS" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}}}
{"type":"assistant/chunk","seq":8,"time":$TS,"data":{"turn":2,"step":1,"chunk":{"type":"block-end","index":0,"block":{"type":"text","text":$(printf '%s' "$OPS" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}}}}
{"type":"assistant/chunk","seq":9,"time":$TS,"data":{"turn":2,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":200,"outputTokens":80,"cacheReadTokens":0,"reasoningTokens":0}}}}
{"type":"assistant/chunk","seq":10,"time":$TS,"data":{"turn":2,"step":1,"chunk":{"type":"finish","reason":{"kind":"stop"}}}}
EOF

export DSH_SNAPSHOT_FILE="$F/session.jsonl"

BEFORE=$(ls "$B/topics" | wc -l)

echo '==> running one real headless turn (distill fires at turn/end)'
set +e
OUT=$(timeout --signal=KILL 90 dsh --profile e2e "随便聊聊项目安排")
rc=$?
set -e
echo "$OUT" | tail -3
[ "$rc" -ne 0 ] && { echo "FAIL: headless turn exited $rc"; exit 1; }

echo '==> waiting for the distill write to settle (up to 15s)'
for i in $(seq 1 15); do
  NOW=$(ls "$B/topics" | wc -l)
  [ "$NOW" -gt "$BEFORE" ] && break
  sleep 1
done
NOW=$(ls "$B/topics" | wc -l)
[ "$NOW" -gt "$BEFORE" ] || { echo 'FAIL: distill never created a topic'; ls "$B/topics"; exit 1; }

NEW=$(ls -t "$B/topics" | head -1)
echo "==> new topic: $NEW"
grep -q 'title: 项目优先级：dsh-cron 对比 pi-tui' "$B/topics/$NEW" \
  || { echo 'FAIL: distilled topic content mismatch'; cat "$B/topics/$NEW"; exit 1; }
git -C "$B" log --oneline | grep -q "create" || { echo 'FAIL: no distill commit'; exit 1; }

echo "PASS 40-headless-distill: distill lane created '$NEW' inside a real dsh process"
