# 매체 CI 출처

2026-10-20에 공식 사이트에서 받은 원본 파일이다. 로고의 색상과 비율을 변경하지 않으며 매체를 식별하는 용도로 사용한다. 각 로고의 권리는 해당 회사에 있고 애플리케이션의 MIT 라이선스에 포함되지 않는다.

| 파일 | 공식 안내 | 원본 파일 |
|---|---|---|
| `meta.svg` | [Meta 브랜드 리소스](https://www.meta.com/brand/resources/meta/company-brand/) | [Meta 심볼](https://static.xx.fbcdn.net/rsrc.php/yf/r/-7pQO6hUGK_.svg) |
| `naver.png` | [NAVER 브랜드 리소스](https://www.navercorp.com/company/brandGuide) | [그린 로고](https://www.navercorp.com/img/pc/logo-type-green.png) |
| `google.png` | [Google 브랜드 리소스](https://about.google/brand-resource-center/) | [Google 로고](https://www.gstatic.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png) |
| `kakao.png` | [카카오 CI](https://www.kakaocorp.com/page/detail/11340) | [공식 CI 미리보기 PNG](https://t1.kakaocdn.net/kakaocorp/kakaocorp/admin/mediakit/47e71270019300001.png?type=thumb&opt=C800x400) |

카카오 CI의 넓은 여백은 화면의 표시 영역에서만 잘라내며 원본 파일은 보존한다.

카카오는 공식 CI 페이지의 800×400 미리보기를 사용해 화면에서 불필요하게 큰 이미지를 디코딩하지 않도록 한다.

## 분리 모델 자산

원천 모델은 `convaiinnovations/laya` commit `7b928d828b7b0e022f929d9bd2e44165aa270148`의 `multilingual/` 파일을 브라우저가 직접 받는다. 원본 가중치·토크나이저를 앱 서버에서 미러링하거나 수정하지 않는다. 별도 LoRA·결정 헤드·조건 헤드와 분리 ONNX 그래프에는 변경 고지를 제공한다. [모델 고지와 Apache-2.0 전문](public/LAYA_MODEL_NOTICE.txt), [브라우저 실행기 제3자 고지](public/THIRD_PARTY_NOTICES.txt)를 함께 배포한다. 애플리케이션 MIT 라이선스로 모델의 권리 조건을 대체하지 않는다.
