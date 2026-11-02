// Версия 3.0 (Специально для iOS)
self.addEventListener('push', function (event) {
    let data = { title: 'LMS Core', body: 'Новое уведомление' };

    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            console.error('Ошибка JSON', e);
        }
    }

    const options = {
        body: data.body || 'Откройте приложение, чтобы посмотреть',
        // ВАЖНО: Мы убрали icon и vibrate, так как они вызывают краш на iOS
        data: {
            url: data.url || '/'
        }
    };

    // Обязательно заворачиваем в waitUntil, иначе iOS убьет пуш
    event.waitUntil(
        self.registration.showNotification(data.title || 'LMS Core', options)
    );
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    if (event.notification.data && event.notification.data.url) {
        event.waitUntil(clients.openWindow(event.notification.data.url));
    } else {
        event.waitUntil(clients.openWindow('/'));
    }
});
