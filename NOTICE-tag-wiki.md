# 태그 위키 데이터 출처

`resources/tag-wiki.json`은 아래 데이터셋을 가공한 것입니다.

- **isek-ai/danbooru-wiki-2024** — https://huggingface.co/datasets/isek-ai/danbooru-wiki-2024
- 라이선스: CC BY-SA 4.0
- 원 출처: Danbooru 위키 (https://danbooru.donmai.us)

가공: general/meta 태그만 남기고, 위키 마크업을 걷어낸 첫 문단(280자)과 한글 별칭만 실었습니다.
갱신: `python scripts/build-tag-wiki.py <parquet>` (스크립트 상단 참고).
