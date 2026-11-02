import { NextResponse } from 'next/server';
import webpush from 'web-push';

const configureWebPush = () => {
    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;

    if (!publicKey || !privateKey) {
        return false;
    }

    // Настраиваем VAPID ключи только при реальной отправке, чтобы сборка не падала без .env.
    const contactEmail = process.env.VAPID_CONTACT_EMAIL ?? 'mailto:admin@lms-core.local';
    webpush.setVapidDetails(contactEmail, publicKey, privateKey);
    return true;
};

export async function POST(req: Request) {
    try {
        const { subscriptions, payload } = await req.json();

        if (!configureWebPush()) {
            return NextResponse.json(
                { error: 'VAPID ключи для Push-уведомлений не настроены на сервере' },
                { status: 500 }
            );
        }

        // Если подписок нет, корректно отвечаем фронтенду
        if (!subscriptions || subscriptions.length === 0) {
            return NextResponse.json({ error: 'Нет подписок для отправки' }, { status: 400 });
        }

        // БРОНИРОВАННАЯ ОТПРАВКА: 
        // Мы оборачиваем каждую отправку в индивидуальный try-catch.
        // Если токен от Google "мертвый" (ошибка 400, 404 или 410),
        // наш бэкенд НЕ упадет, а просто проигнорирует его и пойдет дальше.
        const sendPromises = subscriptions.map(async (sub: any) => {
            try {
                await webpush.sendNotification(sub, JSON.stringify(payload));
            } catch (error: any) {
                // Тихо логируем ошибку конкретного устройства в консоль сервера, но не крашим систему
                console.error(`Ошибка доставки Push на одно из устройств. Код ответа сервера Google/Apple: ${error?.statusCode}`);
            }
        });

        // Ждем, пока сервер попытается отправить все уведомления
        await Promise.all(sendPromises);

        // ОБЯЗАТЕЛЬНО возвращаем успех. 
        // Это скажет админке: "Процесс завершен", и на экране появится зеленая плашка Успеха!
        return NextResponse.json({ success: true });
        
    } catch (error: any) {
        // Сюда код упадет только при критической поломке самого сервера
        console.error('Глобальная критическая ошибка Push API:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
