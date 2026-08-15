# PixelText

**텍스트를 픽셀처럼 원하는 좌표에 놓는, 오프라인 무한 문자 캔버스입니다.**

[![CI](https://github.com/c21senseman/PixelText/actions/workflows/ci.yml/badge.svg)](https://github.com/c21senseman/PixelText/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/c21senseman/PixelText?label=release)](https://github.com/c21senseman/PixelText/releases/latest)

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
- 사각형 선택, 네 방향 크기 조절과 자동 줄바꿈
- 복사·붙여넣기와 가로·세로 밀기 또는 덮어쓰기 이동
- 실행 취소·다시 실행, 전체 검색, 책갈피, 미니맵
- 큰 양수·음수 좌표와 5%–400% 확대
- JSON 문서 가져오기·내보내기와 TXT 내보내기

## 기본 조작

| 작업 | 조작 |
| --- | --- |
| 입력 | 캔버스 클릭 후 바로 입력 |
| 화면 이동 | 마우스 오른쪽 버튼을 누른 채 끌기 |
| 확대·축소 | `Ctrl` + 마우스 휠 |
| 사각형 선택 | 캔버스를 끌기 |
| 선택 크기 변경 | 선택 영역의 상·하·좌·우 경계 끌기 |
| 삽입·덮어쓰기 전환 | `Insert` |
| 실행 취소 / 다시 실행 | `Ctrl+Z` / `Ctrl+Shift+Z` |

도움말 버튼에서 미니맵과 선택 이동을 포함한 전체 조작법을 볼 수 있습니다.

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
