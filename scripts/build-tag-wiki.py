"""
단보루 위키 → resources/tag-wiki.json (커스텀).

출처: isek-ai/danbooru-wiki-2024 (Hugging Face, CC BY-SA 4.0)
  https://huggingface.co/datasets/isek-ai/danbooru-wiki-2024
Danbooru 본진은 국내에서 연결이 끊기고 미러는 봇 검사에 막혀서, 공개 데이터셋을 쓴다.
크롤링이 아니라 정식으로 배포된 파일이라 갱신도 이 스크립트를 다시 돌리면 된다.

무엇을 남기나:
- general / meta 태그만 (캐릭터·작가·작품 태그는 설명이 "~의 캐릭터" 식이라 자동완성에 도움이 안 되고 용량만 크다)
- 설명(body)은 위키 마크업을 걷어내고 첫 문단만, 280자로 자른다
- other_names에서 한글 별칭은 ko로, 나머지는 버린다 (일본어는 검색에 안 쓴다)

사용법:
  python scripts/build-tag-wiki.py <parquet 경로>
"""
import json
import re
import sys
from pathlib import Path

import pyarrow.parquet as pq

src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("danbooru-wiki.parquet")
out = Path(__file__).resolve().parent.parent / "resources" / "tag-wiki.json"

t = pq.read_table(str(src), columns=["tag", "category", "body", "other_names", "is_deleted"])
d = t.to_pydict()

LINK = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]")          # [[tag|label]] → tag
EXT = re.compile(r'"([^"]+)":\[?https?://[^\s\]]+\]?')          # "text":url → text
URL = re.compile(r"https?://\S+")
BB = re.compile(r"\[/?(?:b|i|u|s|tn|quote|expand|spoiler|code|nodtext)[^\]]*\]", re.I)
HEAD = re.compile(r"^h[1-6]\.\s*", re.M)
LIST = re.compile(r"^\s*[*#]+\s*", re.M)
WS = re.compile(r"[ \t]+")
HANGUL = re.compile(r"[가-힣]")


def clean(body: str) -> str:
    s = body.replace("\r\n", "\n")
    s = LINK.sub(lambda m: m.group(1).replace("_", " "), s)
    s = EXT.sub(r"\1", s)
    s = URL.sub("", s)
    s = BB.sub("", s)
    s = HEAD.sub("", s)
    s = LIST.sub("", s)
    # 첫 문단만
    first = next((p for p in s.split("\n\n") if p.strip()), "")
    first = WS.sub(" ", first.replace("\n", " ")).strip()
    if len(first) > 280:
        cut = first[:280]
        # 문장 경계에서 자르기
        m = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
        first = (cut[: m + 1] if m > 120 else cut.rstrip()) + ("" if m > 120 else "…")
    return first


entries = {}
for i, tag in enumerate(d["tag"]):
    if d["is_deleted"][i]:
        continue
    if d["category"][i] not in ("general", "meta"):
        continue
    body = clean(d["body"][i] or "")
    ko = [s for s in (d["other_names"][i] or []) if HANGUL.search(s)]
    if not body and not ko:
        continue
    entry = {}
    if body:
        entry["en"] = body
    if ko:
        entry["ko"] = ko
    entries[tag.replace("_", " ")] = entry

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(entries, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"wrote {out} — {len(entries)} tags, {out.stat().st_size // 1024} KB")
print("  with ko:", sum(1 for e in entries.values() if "ko" in e))
