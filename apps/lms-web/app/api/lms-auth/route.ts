import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

const getBackendConfig = () => ({
    apiUrl: process.env.DEPLOY_PANEL_API_URL ?? 'http://127.0.0.1:3001',
    devUserId: process.env.DEPLOY_PANEL_DEV_USER_ID ?? '00000000-0000-4000-8000-000000000001',
    devClientId: process.env.DEPLOY_PANEL_DEV_CLIENT_ID ?? 'dev-client'
});

const getBackendHeaders = () => {
    const config = getBackendConfig();

    return {
        'x-dev-role-code': 'system_admin',
        'x-dev-user-id': config.devUserId,
        'x-dev-client-id': config.devClientId,
        'Content-Type': 'application/json'
    };
};

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const action = body?.action === 'register' ? 'legacy-register' : 'legacy-login';

        if (!body?.clientId || !body?.login || !body?.password) {
            return NextResponse.json({ error: 'Не указан клиент, логин или пароль' }, { status: 400 });
        }

        const config = getBackendConfig();
        const response = await fetch(`${config.apiUrl}/api/users/${action}`, {
            method: 'POST',
            cache: 'no-store',
            headers: getBackendHeaders(),
            body: JSON.stringify({
                clientId: body.clientId,
                login: body.login,
                password: body.password,
                name: body.name,
                phone: body.phone
            })
        });

        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
            return NextResponse.json(payload, { status: response.status });
        }

        return NextResponse.json(payload, {
            status: 200,
            headers: {
                'Cache-Control': 'no-store'
            }
        });
    } catch (error) {
        console.error('Ошибка LMS auth proxy:', error);
        return NextResponse.json({ error: 'Ошибка сервера авторизации' }, { status: 500 });
    }
}
