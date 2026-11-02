export const saveDataToServer = async (key: string, data: any) => {
    try {
        const response = await fetch('/api/storage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, data }),
        });

        if (!response.ok) {
            const errorPayload = await response.json().catch(() => null);
            const errorMessage = errorPayload?.error ?? `HTTP ${response.status}`;
            console.error(`Ошибка сохранения ключа ${key}: ${errorMessage}`);
            return null;
        }

        return response;
    } catch (error) {
        console.error(`Ошибка соединения при сохранении ключа ${key}:`, error);
        return null;
    }
};

export const fetchStorageBatch = async (keys: string[]) => {
    const response = await fetch(`/api/storage?keys=${encodeURIComponent(keys.join(','))}`, {
        cache: 'no-store',
    });

    if (!response.ok) {
        throw new Error(`Ошибка пакетной загрузки данных: ${response.status}`);
    }

    return response.json();
};
