# PixelText

[English](README.md) | [한국어](README.ko.md)

**텍스트를 픽셀처럼 원하는 좌표에 놓는, 오프라인 무한 문자 캔버스입니다.**

[![CI](https://github.com/c21senseman/PixelText/actions/workflows/ci.yml/badge.svg)](https://github.com/c21senseman/PixelText/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/c21senseman/PixelText?label=release)](https://github.com/c21senseman/PixelText/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[최신 `pixeltext.html` 다운로드](https://github.com/c21senseman/PixelText/releases/latest/download/pixeltext.html)

PixelText는 문서나 화이트보드처럼 줄에 갇히지 않고, 2차원 셀 공간 어디서든 바로 글을 쓰고 정리할 수 있는 Canvas 기반 편집기입니다. 설치·계정·서버가 필요 없고 한글 IME와 이모지 문자소 묶음을 지원합니다.

## 바로 사용하기

1. 위의 **최신 `pixeltext.html` 다운로드**를 누릅니다.
2. 내려받은 파일을 최신 브라우저에서 엽니다.
3. 캔버스를 클릭하고 입력합니다. 내용은 현재 브라우저 프로필에 자동 저장됩니다.

> 브라우저 사이트 데이터나 프로필을 삭제하면 자동 저장 문서도 사라질 수 있습니다. 중요한 문서는 상단 메뉴에서 JSON으로 내보내 백업하세요.

## 무엇을 할 수 있나요?

- 64×64 희소 청크 기반의 경계 없는 문자 캔버스
- 저장하지 않는 빈칸과 문자 사이 한 칸 공백을 구분하는 텍스트 모델
- 삽입·덮어쓰기 편집, Enter 줄 분리, Backspace/Delete 당김
- 굵게·기울임·밑줄·취소선과 기본값 1부터 시작하는 자연수 글자 크기(별도 상한 없음), 선택·커서에 따른 서식 동기화
- 혼합 글자 크기에 맞춘 배치·커서 이동·선택·줄바꿈과 서식 보존 복사·붙여넣기
- 사각형 선택, 네 방향 크기 조절과 자동 줄바꿈
- 영문·공백 1칸, 한글·한자·이모지 2칸 배치
- 커서·선택 이동 및 드래그 중 자동 스크롤
- 복사·붙여넣기와 가로·세로 밀기 또는 덮어쓰기 이동
- 실행 취소·다시 실행, 전체 검색, 책갈피, 미니맵
- 큰 양수·음수 좌표와 5%–400% 확대
- JSON 문서 가져오기·내보내기와 TXT 내보내기

## 기본 조작

| 작업 | 조작 |
| --- | --- |
| 입력 | 캔버스 클릭 후 바로 입력 |
| 화면 이동 | 마우스 오른쪽 또는 휠 버튼을 누른 채 끌기 |
| 스크롤 | 마우스 휠 (마지막 화면 이동 축, 기본 세로) |
| 확대·축소 | `Ctrl` + 마우스 휠 |
| 사각형 선택 | 캔버스를 끌기 |
| 선택 크기 변경 | 선택 영역의 상·하·좌·우 경계 끌기 |
| 삽입·덮어쓰기 전환 | `Insert` |
| 굵게 / 기울임 / 밑줄 | `Ctrl/Cmd+B` / `Ctrl/Cmd+I` / `Ctrl/Cmd+U` |
| 글자 크기 | 상단 숫자 입력 후 Enter 또는 A− / A+ |
| 실행 취소 / 다시 실행 | `Ctrl+Z` / `Ctrl+Shift+Z` |

도움말 버튼에서 미니맵과 선택 이동을 포함한 전체 조작법을 볼 수 있습니다.

서식은 선택한 글자에 적용하며, 선택이 없으면 다음 입력에 적용합니다. 크기는 자연수 배율로 지정합니다. 크기 2는 크기 1의 가로·세로 두 배이며, 이동·선택의 기본 격자는 항상 12×24px로 고정됩니다. 크기가 섞인 선택에는 `혼합`을 표시합니다. JSON과 자동 저장은 글자 서식을 보존하고 이전 버전 문서도 열 수 있습니다. TXT와 외부 일반 텍스트 붙여넣기는 서식 없는 텍스트를 사용합니다.

## 데이터와 개인정보

배포본은 백엔드, 로그인, 원격 분석 코드 없이 브라우저 안에서만 실행됩니다. 문서는 브라우저의 IndexedDB에 자동 저장됩니다. 가져온 JSON은 적용 전에 구조와 좌표, 문자소, 책갈피, 크기 제한을 모두 검사하며 실패하면 기존 문서를 바꾸지 않습니다.

자세한 제보 절차는 [보안 정책](SECURITY.md)을 참고하세요.

## 로컬 개발

Node.js 22.13.0 이상이 필요합니다.

```bash
git clone https://github.com/c21senseman/PixelText.git
cd PixelText
npm ci
npm run dev
```

전체 검증은 한 명령으로 실행할 수 있습니다.

```bash
npm run check
```

개별 명령은 다음과 같습니다.

| 명령 | 설명 |
| --- | --- |
| `npm test` | 편집 엔진 테스트 |
| `npm run typecheck` | TypeScript 타입 검사 |
| `npm run lint` | ESLint 정적 검사 |
| `npm run build` | `dist/index.html` 단일 파일 빌드 |
| `npm run start` | 빌드 결과 미리보기 |

## 프로젝트 구조

| 경로 | 역할 |
| --- | --- |
| `src/` | React UI와 스타일 |
| `lib/` | 문서 모델, 편집 명령, 렌더러, 저장소, 입출력 |
| `tests/` | 편집 엔진과 문서 형식 테스트 |
| `build/` | JavaScript와 CSS를 단일 HTML에 넣는 Vite 플러그인 |
| `spec.md` | 기능 및 데이터 모델 명세 |
| `ux.md` | 상호작용 원칙과 UX 명세 |

## 릴리스 빌드

```bash
npm ci
npm run check
```

산출물은 `dist/index.html` 하나입니다. React 런타임, 편집기 코드, 스타일과 아이콘이 모두 포함되어 별도 서버나 정적 자산 없이 배포하고 오프라인에서 열 수 있습니다. 변경 내역은 [CHANGELOG.md](CHANGELOG.md)에서 확인할 수 있습니다.

## 라이선스

PixelText는 [MIT 라이선스](LICENSE)로 제공됩니다.
