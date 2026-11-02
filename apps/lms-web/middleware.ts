import { NextResponse, type NextRequest } from "next/server";

// The old adapted UI is retired. Keep the settings/upload APIs for the replacement editor.
export function middleware(request: NextRequest) {
  return new NextResponse(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Старое превью отключено</title><style>body{margin:0;background:#191c22;color:#edf1f7;font:16px/1.6 sans-serif;display:grid;min-height:100vh;place-items:center}main{max-width:580px;padding:32px}h1{font-size:26px}p{color:#b9c3d3}</style><main><h1>Старое превью отключено</h1><p>Эта адаптированная страница не соответствует устанавливаемой Git-LMS и больше не используется.</p><p>В приложении Core откройте «Клиенты» → «LMS из Git», выберите клиента и нажмите «Запустить локально».</p><p>Сохраненные настройки и данные клиентов не удалены.</p></main></html>`, {
    status: request.nextUrl.pathname === "/" ? 200 : 410,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'", "X-Content-Type-Options": "nosniff" }
  });
}

export const config = { matcher: ["/((?!api(?:/|$)|_next(?:/|$)|favicon.ico$|robots.txt$).*)"] };
