// .env 줄을 통째로 붙여넣어 값에 따옴표/공백이 섞인 경우를 정리
export const clean = (v?: string) => (v ?? "").trim().replace(/^["']|["']$/g, "").trim();

export const env = (name: string) => clean(process.env[name]);
