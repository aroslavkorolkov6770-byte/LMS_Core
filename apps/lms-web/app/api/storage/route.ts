import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

// Папка для хранения файлов (создастся в корне проекта)
const dataDir = path.join(process.cwd(), 'data');
const seedDataDir = path.join(dataDir, 'seed');

const storageKeyAliases: Record<string, string> = {
    core_lms_route_v1: 'tea_hub_dynamic_route_v2',
    core_lms_tests_v1: 'tea_hub_dynamic_tests_v1',
    core_lms_documents_v1: 'tea_hub_urgent_files_v1',
    core_lms_users_v1: 'tea_hub_users_v1',
    core_lms_test_results_v1: 'tea_hub_test_results_v1',
    core_lms_assortment_v1: 'tea_hub_assortment_matrix_v2',
    core_lms_products_v1: 'tea_hub_products_v1',
    core_lms_notifications_v1: 'tea_hub_notifications_v1',
    core_lms_push_subscriptions_v1: 'tea_hub_push_subs_v1',
    core_lms_test_types_v1: 'tea_hub_test_types_v1',
    core_lms_onboard_route_v1: 'tea_hub_onboard_route_v2'
};

const canonicalStorageKey = (rawKey: string) => storageKeyAliases[rawKey] ?? rawKey;

const seedKeyMap: Record<string, string[]> = {
    tea_hub_dynamic_route_v2: ['tea_hub_dynamic_route_v2'],
    tea_hub_dynamic_tests_v1: ['tea_hub_dynamic_tests_v1'],
    tea_hub_assortment_matrix_v2: ['tea_hub_assortment_matrix_v2', 'tea_hub_assortment_matrix_v1'],
    tea_hub_products_v1: ['tea_hub_products_v1']
};
const backendDrivenKeys = new Set([
    'admin_cal_notes_v1',
    'tea_hub_dynamic_route_v2',
    'tea_hub_dynamic_tests_v1',
    'tea_hub_urgent_files_v1',
    'tea_hub_assortment_matrix_v2',
    'tea_hub_products_v1',
    'tea_hub_users_v1',
    'tea_hub_test_results_v1',
    'tea_hub_notifications_v1',
    'tea_hub_push_subs_v1'
]);
const clientContentKeys = new Set([
    'tea_hub_assortment_matrix_v2',
    'tea_hub_products_v1',
    'tea_hub_test_types_v1',
    'tea_hub_onboard_route_v2'
]);
const backendClientContentKeyAliases: Record<string, string> = {
    tea_hub_test_types_v1: 'core_lms_test_types_v1',
    tea_hub_onboard_route_v2: 'core_lms_onboard_route_v1'
};
const blockedStorageKeys = new Set([
    'core_lms_basics_v1',
    'tea_hub_dynamic_basics_v2'
]);

const isBlockedStorageKey = (rawKey: string) => {
    return blockedStorageKeys.has(rawKey) || rawKey.startsWith('prog_basics_');
};

const isClientContentKey = (rawKey: string) => {
    return clientContentKeys.has(rawKey);
};

const getBackendClientContentKey = (rawKey: string) => {
    return backendClientContentKeyAliases[rawKey] ?? rawKey;
};

const isBackendDrivenKey = (rawKey: string) => {
    const key = canonicalStorageKey(rawKey);

    return (
        backendDrivenKeys.has(key) ||
        isClientContentKey(key) ||
        isRouteProgressKey(key) ||
        isTestProgressKey(key) ||
        isProfileDataKey(key) ||
        isDismissedTasksKey(key) ||
        isAiHistoryKey(key) ||
        isDocumentFileKey(key)
    );
};

const routeProgressPrefix = 'prog_route_';
const testProgressPrefixes = ['prog_tests_', 'th_passed_tests_'];
const profileDataPrefix = 'profile_data_';
const dismissedTasksPrefix = 'dismissed_tasks_';
const aiHistoryPrefix = 'th_ai_history_';
const documentFilePrefix = 'file_data_';
const legacyAssignmentsBackendKey = 'core_lms_assignments_v1';

const isRouteProgressKey = (rawKey: string) => rawKey.startsWith(routeProgressPrefix);

const getRouteProgressUserId = (rawKey: string) => rawKey.slice(routeProgressPrefix.length);

const isTestProgressKey = (rawKey: string) => testProgressPrefixes.some((prefix) => rawKey.startsWith(prefix));

const getTestProgressUserId = (rawKey: string) => {
    const prefix = testProgressPrefixes.find((item) => rawKey.startsWith(item));
    return prefix ? rawKey.slice(prefix.length) : '';
};

const isProfileDataKey = (rawKey: string) => rawKey.startsWith(profileDataPrefix);

const getProfileDataUserKey = (rawKey: string) => rawKey.slice(profileDataPrefix.length);

const isDismissedTasksKey = (rawKey: string) => rawKey.startsWith(dismissedTasksPrefix);

const getDismissedTasksUserKey = (rawKey: string) => rawKey.slice(dismissedTasksPrefix.length);

const isAiHistoryKey = (rawKey: string) => rawKey.startsWith(aiHistoryPrefix);

const getAiHistoryUserKey = (rawKey: string) => rawKey.slice(aiHistoryPrefix.length);

const isDocumentFileKey = (rawKey: string) => rawKey.startsWith(documentFilePrefix);

const getDocumentFileKey = (rawKey: string) => rawKey.slice(documentFilePrefix.length);

// Функция для очистки имени файла (чтобы логины типа admin@mail.ru не ломали систему файлов)
const sanitizeKey = (key: string) => {
    return key.replace(/[^a-zA-Z0-9_-]/g, '_');
};

const ensureDataDir = () => {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
};

const readStorageValue = (rawKey: string) => {
    const safeKey = sanitizeKey(rawKey);
    const filePath = path.join(dataDir, `${safeKey}.json`);

    if (!fs.existsSync(filePath)) {
        return seedStorageValue(rawKey);
    }

    const fileData = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(fileData);
};

const seedStorageValue = (rawKey: string) => {
    const seedValue = normalizeStorageValue(rawKey, readSeedStorageValue(rawKey));

    if (Array.isArray(seedValue) && seedValue.length > 0) {
        const safeKey = sanitizeKey(rawKey);
        const filePath = path.join(dataDir, `${safeKey}.json`);
        fs.writeFileSync(filePath, JSON.stringify(seedValue, null, 2), 'utf8');
    }

    return seedValue;
};

const readSeedStorageValue = (rawKey: string) => {
    const seedKeys = seedKeyMap[rawKey] ?? [rawKey];

    for (const seedKey of seedKeys) {
        const safeSeedKey = sanitizeKey(seedKey);
        const seedPath = path.join(seedDataDir, `${safeSeedKey}.json`);

        if (fs.existsSync(seedPath)) {
            const fileData = fs.readFileSync(seedPath, 'utf8');
            return JSON.parse(fileData);
        }
    }

    return [];
};

const normalizeStorageValue = (rawKey: string, value: any) => {
    return value;
};

const getBackendConfig = () => ({
    apiUrl: process.env.DEPLOY_PANEL_API_URL ?? 'http://127.0.0.1:3001',
    devUserId: process.env.DEPLOY_PANEL_DEV_USER_ID ?? '00000000-0000-4000-8000-000000000001',
    devClientId: process.env.DEPLOY_PANEL_DEV_CLIENT_ID ?? 'dev-client'
});

const resolvePreviewClientId = (request: Request, url: URL) => {
    const fromQuery = url.searchParams.get('previewClientId') ?? url.searchParams.get('clientId');

    if (fromQuery) {
        return fromQuery;
    }

    const fromHeader = request.headers.get('x-preview-client-id');

    if (fromHeader) {
        return fromHeader;
    }

    const referer = request.headers.get('referer');

    if (!referer) {
        return null;
    }

    try {
        const refererUrl = new URL(referer);
        return refererUrl.searchParams.get('previewClientId') ?? refererUrl.searchParams.get('clientId');
    } catch {
        return null;
    }
};

const normalizeBackendCourse = (item: any) => {
    if (item?.content && typeof item.content === 'object' && !Array.isArray(item.content)) {
        return item.content;
    }

    return {
        id: item?.slug ?? item?.id ?? `route_${Date.now()}`,
        title: item?.title ?? 'Маршрут',
        time: item?.estimatedMinutes ? `${item.estimatedMinutes} мин` : '5 мин',
        h1: item?.title ?? 'Тема',
        t1: item?.description ?? '',
        h2: '',
        t2: '',
        h3: '',
        t3: ''
    };
};

const normalizeBackendTest = (item: any) => {
    if (item?.content && typeof item.content === 'object' && !Array.isArray(item.content)) {
        return item.content;
    }

    return {
        id: item?.slug ?? item?.id ?? `test_${Date.now()}`,
        title: item?.title ?? 'Тест',
        subtitle: item?.description ?? 'Раздел обучения',
        theory: item?.description ?? '',
        section: item?.description ?? 'Раздел обучения',
        timeLimit: item?.timeLimitMinutes ?? 0,
        quiz: []
    };
};

const normalizeBackendDocument = (item: any) => ({
    id: item?.slug ?? item?.id ?? `doc_${Date.now()}`,
    name: item?.title ?? 'Документ',
    size: '',
    date: item?.createdAt ? new Date(item.createdAt).toLocaleDateString('ru-RU') : '',
    section: item?.description ?? 'Основной раздел',
    hasSeparateData: Boolean(item?.storagePath),
    storagePath: item?.storagePath ?? null,
    mimeType: item?.mimeType ?? 'application/octet-stream',
    isPublished: item?.isPublished !== false
});

const syncLearningRouteToBackend = async (
    previewClientId: string | null,
    data: any
): Promise<boolean> => {
    if (!previewClientId || !Array.isArray(data)) {
        return false;
    }

    const config = getBackendConfig();

    return postBackendJson(
        `${config.apiUrl}/api/learning-content/legacy-route`,
        {
            clientId: previewClientId,
            items: data
        },
        'учебных тем'
    );
};

const syncLearningTestsToBackend = async (
    previewClientId: string | null,
    data: any
): Promise<boolean> => {
    if (!previewClientId || !Array.isArray(data)) {
        return false;
    }

    const config = getBackendConfig();

    return postBackendJson(
        `${config.apiUrl}/api/learning-content/legacy-tests`,
        {
            clientId: previewClientId,
            items: data
        },
        'учебных тестов'
    );
};

const getBackendHeaders = () => {
    const config = getBackendConfig();

    return {
        'x-dev-role-code': 'system_admin',
        'x-dev-user-id': config.devUserId,
        'x-dev-client-id': config.devClientId
    };
};

const postBackendJson = async (
    url: string,
    payload: unknown,
    context: string
): Promise<boolean> => {
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                ...getBackendHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.error(`Backend не сохранил ${context}: статус ${response.status}`);
            return false;
        }

        return true;
    } catch (error) {
        console.error(`Ошибка backend-сохранения ${context}:`, error);
        return false;
    }
};

const fetchBackendStorageValue = async (rawKey: string, previewClientId: string | null) => {
    const key = canonicalStorageKey(rawKey);

    if (!previewClientId || !isBackendDrivenKey(key)) {
        return null;
    }

    const config = getBackendConfig();

    try {
        if (key === 'tea_hub_dynamic_route_v2') {
            const response = await fetch(
                `${config.apiUrl}/api/learning-content/legacy-route?clientId=${encodeURIComponent(previewClientId)}`,
                {
                    cache: 'no-store',
                    headers: getBackendHeaders()
                }
            );

            if (!response.ok) {
                return null;
            }

            const payload = await response.json();
            const items = Array.isArray(payload?.items) ? payload.items : [];
            return items;
        }

        if (key === 'tea_hub_dynamic_tests_v1') {
            const response = await fetch(
                `${config.apiUrl}/api/learning-content/legacy-tests?clientId=${encodeURIComponent(previewClientId)}`,
                {
                    cache: 'no-store',
                    headers: getBackendHeaders()
                }
            );

            if (!response.ok) {
                return null;
            }

            const payload = await response.json();
            const items = Array.isArray(payload?.items) ? payload.items : [];
            return items;
        }

        if (key === 'tea_hub_urgent_files_v1') {
            const [documentsResponse, assignmentsResponse] = await Promise.all([
                fetch(
                    `${config.apiUrl}/api/documents?clientId=${encodeURIComponent(previewClientId)}&limit=500`,
                    {
                        cache: 'no-store',
                        headers: getBackendHeaders()
                    }
                ),
                fetch(
                    `${config.apiUrl}/api/admin-ops/client-content?clientId=${encodeURIComponent(previewClientId)}&key=${encodeURIComponent(legacyAssignmentsBackendKey)}`,
                    {
                        cache: 'no-store',
                        headers: getBackendHeaders()
                    }
                )
            ]);

            if (!documentsResponse.ok) {
                return null;
            }

            const documentsPayload = await documentsResponse.json();
            const assignmentsPayload = assignmentsResponse.ok
                ? await assignmentsResponse.json()
                : null;
            const documents = Array.isArray(documentsPayload?.items)
                ? documentsPayload.items.map(normalizeBackendDocument)
                : [];
            const assignments = Array.isArray(assignmentsPayload?.payload)
                ? assignmentsPayload.payload
                : [];

            return [...assignments, ...documents];
        }

        if (key === 'tea_hub_users_v1') {
            const response = await fetch(
                `${config.apiUrl}/api/users/legacy?clientId=${encodeURIComponent(previewClientId)}&limit=500`,
                {
                    cache: 'no-store',
                    headers: getBackendHeaders()
                }
            );

            if (!response.ok) {
                return null;
            }

            const payload = await response.json();
            return Array.isArray(payload?.items) ? payload.items : [];
        }

        if (key === 'tea_hub_test_results_v1') {
            const response = await fetch(
                `${config.apiUrl}/api/test-attempts/legacy-results?clientId=${encodeURIComponent(previewClientId)}`,
                {
                    cache: 'no-store',
                    headers: getBackendHeaders()
                }
            );

            if (!response.ok) {
                return null;
            }

            const payload = await response.json();
            return Array.isArray(payload?.items) ? payload.items : [];
        }

        if (key === 'tea_hub_notifications_v1') {
            const response = await fetch(
                `${config.apiUrl}/api/notifications/legacy?clientId=${encodeURIComponent(previewClientId)}&limit=500`,
                {
                    cache: 'no-store',
                    headers: getBackendHeaders()
                }
            );

            if (!response.ok) {
                return null;
            }

            const payload = await response.json();
            return Array.isArray(payload?.items) ? payload.items : [];
        }

        if (key === 'tea_hub_push_subs_v1') {
            const response = await fetch(
                `${config.apiUrl}/api/push-subscriptions/legacy?clientId=${encodeURIComponent(previewClientId)}&limit=500`,
                {
                    cache: 'no-store',
                    headers: getBackendHeaders()
                }
            );

            if (!response.ok) {
                return null;
            }

            const payload = await response.json();
            return Array.isArray(payload?.items) ? payload.items : [];
        }

        if (key === 'admin_cal_notes_v1') {
            const response = await fetch(
                `${config.apiUrl}/api/admin-calendar-notes/legacy?clientId=${encodeURIComponent(previewClientId)}`,
                {
                    cache: 'no-store',
                    headers: getBackendHeaders()
                }
            );

            if (!response.ok) {
                return null;
            }

            const payload = await response.json();
            const notes = payload?.notes;

            return notes && typeof notes === 'object' && !Array.isArray(notes) && Object.keys(notes).length > 0
                ? notes
                : null;
        }

        if (isProfileDataKey(key)) {
            const userKey = getProfileDataUserKey(key);

            if (!userKey) {
                return null;
            }

            const response = await fetch(
                `${config.apiUrl}/api/user-profile-data/legacy?clientId=${encodeURIComponent(previewClientId)}&userKey=${encodeURIComponent(userKey)}`,
                {
                    cache: 'no-store',
                    headers: getBackendHeaders()
                }
            );

            if (!response.ok) {
                return null;
            }

            const payload = await response.json();
            return payload?.payload ?? null;
        }

        if (isDismissedTasksKey(key)) {
            const userKey = getDismissedTasksUserKey(key);

            if (!userKey) {
                return null;
            }

            const response = await fetch(
                `${config.apiUrl}/api/dismissed-tasks/legacy?clientId=${encodeURIComponent(previewClientId)}&userKey=${encodeURIComponent(userKey)}`,
                {
                    cache: 'no-store',
                    headers: getBackendHeaders()
                }
            );

            if (response.ok) {
                const payload = await response.json();

                if (payload?.exists) {
                    return Array.isArray(payload?.taskKeys) ? payload.taskKeys : [];
                }
            }

            const legacyResponse = await fetch(
                `${config.apiUrl}/api/admin-ops/client-content?clientId=${encodeURIComponent(previewClientId)}&key=${encodeURIComponent(key)}`,
                {
                    cache: 'no-store',
                    headers: getBackendHeaders()
                }
            );

            if (!legacyResponse.ok) {
                return null;
            }

            const legacyPayload = await legacyResponse.json();
            return Array.isArray(legacyPayload?.payload) ? legacyPayload.payload : null;
        }

        if (isAiHistoryKey(key)) {
            const userKey = getAiHistoryUserKey(key);

            if (!userKey) {
                return null;
            }

            const response = await fetch(
                `${config.apiUrl}/api/ai-history/legacy?clientId=${encodeURIComponent(previewClientId)}&userKey=${encodeURIComponent(userKey)}`,
                {
                    cache: 'no-store',
                    headers: getBackendHeaders()
                }
            );

            if (!response.ok) {
                return null;
            }

            const payload = await response.json();
            return payload?.exists && Array.isArray(payload?.sessions) ? payload.sessions : null;
        }

        if (isDocumentFileKey(key)) {
            const fileKey = getDocumentFileKey(key);

            if (!fileKey) {
                return null;
            }

            const response = await fetch(
                `${config.apiUrl}/api/document-files/legacy?clientId=${encodeURIComponent(previewClientId)}&fileKey=${encodeURIComponent(fileKey)}`,
                {
                    cache: 'no-store',
                    headers: getBackendHeaders()
                }
            );

            if (response.status === 404) {
                return null;
            }

            if (!response.ok) {
                throw new Error(`Backend document file вернул статус ${response.status}`);
            }

            const mimeType = response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream';
            const fileBuffer = Buffer.from(await response.arrayBuffer());

            return `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
        }

        if (isRouteProgressKey(key)) {
            const userId = getRouteProgressUserId(key);

            const response = await fetch(
                `${config.apiUrl}/api/progress/legacy-route?clientId=${encodeURIComponent(previewClientId)}&userId=${encodeURIComponent(userId)}`,
                {
                    cache: 'no-store',
                    headers: getBackendHeaders()
                }
            );

            if (!response.ok) {
                return null;
            }

            const payload = await response.json();
            return Array.isArray(payload?.completedRouteSlugs) ? payload.completedRouteSlugs : [];
        }

        if (isTestProgressKey(key)) {
            const userId = getTestProgressUserId(key);

            const response = await fetch(
                `${config.apiUrl}/api/test-attempts/legacy-passed?clientId=${encodeURIComponent(previewClientId)}&userId=${encodeURIComponent(userId)}`,
                {
                    cache: 'no-store',
                    headers: getBackendHeaders()
                }
            );

            if (!response.ok) {
                return null;
            }

            const payload = await response.json();
            return Array.isArray(payload?.passedTestSlugs) ? payload.passedTestSlugs : [];
        }

        if (isClientContentKey(key)) {
            const backendKey = getBackendClientContentKey(key);
            const response = await fetch(
                `${config.apiUrl}/api/admin-ops/client-content?clientId=${encodeURIComponent(previewClientId)}&key=${encodeURIComponent(backendKey)}`,
                {
                    cache: 'no-store',
                    headers: getBackendHeaders()
                }
            );

            if (!response.ok) {
                return null;
            }

            const payload = await response.json();
            return payload?.payload ?? null;
        }
    } catch (error) {
        console.error(`Ошибка чтения backend-ключа ${rawKey}:`, error);
    }

    return null;
};

const isLegacyDocumentItem = (value: any) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    if (value.isDocPlaceholder || value.isTest || value.id?.startsWith('deadline_')) {
        return false;
    }

    return Boolean(value.id && value.name);
};

const syncDocumentsToBackend = async (
    previewClientId: string | null,
    data: any
): Promise<boolean> => {
    if (!previewClientId || !Array.isArray(data)) {
        return false;
    }

    const config = getBackendConfig();
    const documentsSaved = await postBackendJson(
        `${config.apiUrl}/api/documents/legacy-sync`,
        {
            clientId: previewClientId,
            items: data
        },
        'метаданных документов'
    );

    if (!documentsSaved) {
        return false;
    }

    const assignments = data.filter((item: any) => !isLegacyDocumentItem(item));

    return postBackendJson(
        `${config.apiUrl}/api/admin-ops/client-content`,
        {
            clientId: previewClientId,
            key: legacyAssignmentsBackendKey,
            payload: assignments
        },
        'назначений и разделов документов'
    );
};

const syncClientContentToBackend = async (
    previewClientId: string | null,
    rawKey: string,
    data: any
): Promise<boolean> => {
    const key = canonicalStorageKey(rawKey);

    if (!previewClientId || !isClientContentKey(key)) {
        return false;
    }

    const config = getBackendConfig();

    return postBackendJson(
        `${config.apiUrl}/api/admin-ops/client-content`,
        {
            clientId: previewClientId,
            key: getBackendClientContentKey(key),
            payload: data
        },
        `контента клиента ${key}`
    );
};

const syncUsersToBackend = async (previewClientId: string | null, data: any) => {
    if (!previewClientId || !Array.isArray(data)) {
        return;
    }

    const config = getBackendConfig();

    await fetch(`${config.apiUrl}/api/users/legacy-sync`, {
        method: 'POST',
        headers: {
            ...getBackendHeaders(),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            clientId: previewClientId,
            users: data
        })
    }).catch((error) => {
        console.error('Ошибка синхронизации пользователей LMS:', error);
    });
};

const syncRouteProgressToBackend = async (
    previewClientId: string | null,
    rawKey: string,
    data: any
): Promise<boolean> => {
    const key = canonicalStorageKey(rawKey);

    if (!previewClientId || !isRouteProgressKey(key) || !Array.isArray(data)) {
        return false;
    }

    const config = getBackendConfig();
    const userId = getRouteProgressUserId(key);

    return postBackendJson(
        `${config.apiUrl}/api/progress/legacy-route`,
        {
            clientId: previewClientId,
            userId,
            completedRouteSlugs: data
        },
        `прогресса маршрута ${key}`
    );
};

const syncTestResultsToBackend = async (previewClientId: string | null, rawKey: string, data: any) => {
    const key = canonicalStorageKey(rawKey);

    if (!previewClientId || key !== 'tea_hub_test_results_v1' || !Array.isArray(data)) {
        return;
    }

    const config = getBackendConfig();

    await fetch(`${config.apiUrl}/api/test-attempts/legacy-results`, {
        method: 'POST',
        headers: {
            ...getBackendHeaders(),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            clientId: previewClientId,
            results: data
        })
    }).catch((error) => {
        console.error('Ошибка синхронизации результатов тестов:', error);
    });
};

const syncNotificationsToBackend = async (
    previewClientId: string | null,
    rawKey: string,
    data: any
): Promise<boolean> => {
    const key = canonicalStorageKey(rawKey);

    if (!previewClientId || key !== 'tea_hub_notifications_v1' || !Array.isArray(data)) {
        return false;
    }

    const config = getBackendConfig();

    return postBackendJson(
        `${config.apiUrl}/api/notifications/legacy`,
        {
            clientId: previewClientId,
            items: data
        },
        'уведомлений'
    );
};

const syncPushSubscriptionsToBackend = async (
    previewClientId: string | null,
    rawKey: string,
    data: any
): Promise<boolean> => {
    const key = canonicalStorageKey(rawKey);

    if (!previewClientId || key !== 'tea_hub_push_subs_v1' || !Array.isArray(data)) {
        return false;
    }

    const config = getBackendConfig();

    return postBackendJson(
        `${config.apiUrl}/api/push-subscriptions/legacy`,
        {
            clientId: previewClientId,
            items: data
        },
        'push-подписок'
    );
};

const syncProfileDataToBackend = async (
    previewClientId: string | null,
    rawKey: string,
    data: any
): Promise<boolean> => {
    const key = canonicalStorageKey(rawKey);
    const userKey = getProfileDataUserKey(key);

    if (!previewClientId || !isProfileDataKey(key) || !userKey || !data || typeof data !== 'object' || Array.isArray(data)) {
        return false;
    }

    const config = getBackendConfig();

    return postBackendJson(
        `${config.apiUrl}/api/user-profile-data/legacy`,
        {
                clientId: previewClientId,
                userKey,
                payload: data
        },
        `профиля ${key}`
    );
};

const syncAdminCalendarNotesToBackend = async (
    previewClientId: string | null,
    rawKey: string,
    data: any
): Promise<boolean> => {
    const key = canonicalStorageKey(rawKey);

    if (
        !previewClientId ||
        key !== 'admin_cal_notes_v1' ||
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data)
    ) {
        return false;
    }

    const config = getBackendConfig();

    return postBackendJson(
        `${config.apiUrl}/api/admin-calendar-notes/legacy`,
        {
                clientId: previewClientId,
                notes: data
        },
        'заметок календаря'
    );
};

const syncDismissedTasksToBackend = async (
    previewClientId: string | null,
    rawKey: string,
    data: any
): Promise<boolean> => {
    const key = canonicalStorageKey(rawKey);
    const userKey = getDismissedTasksUserKey(key);

    if (!previewClientId || !isDismissedTasksKey(key) || !userKey || !Array.isArray(data)) {
        return false;
    }

    const config = getBackendConfig();

    return postBackendJson(
        `${config.apiUrl}/api/dismissed-tasks/legacy`,
        {
                clientId: previewClientId,
                userKey,
                taskKeys: data
        },
        `скрытых задач ${key}`
    );
};

const syncAiHistoryToBackend = async (
    previewClientId: string | null,
    rawKey: string,
    data: any
): Promise<boolean> => {
    const key = canonicalStorageKey(rawKey);
    const userKey = getAiHistoryUserKey(key);

    if (!previewClientId || !isAiHistoryKey(key) || !userKey || !Array.isArray(data)) {
        return false;
    }

    const config = getBackendConfig();

    try {
        const response = await fetch(`${config.apiUrl}/api/ai-history/legacy`, {
            method: 'POST',
            headers: {
                ...getBackendHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                clientId: previewClientId,
                userKey,
                sessions: data
            })
        });

        if (!response.ok) {
            console.error(`Backend AI history вернул статус ${response.status}`);
            return false;
        }

        return true;
    } catch (error) {
        console.error(`Ошибка защищенной синхронизации AI history ${key}:`, error);
        return false;
    }
};

const parseDataUrl = (value: unknown): { mimeType: string; data: Buffer } | null => {
    if (typeof value !== 'string') {
        return null;
    }

    const match = /^data:([^;,]+);base64,([a-zA-Z0-9+/=\r\n]*)$/.exec(value);

    if (!match) {
        return null;
    }

    return {
        mimeType: match[1],
        data: Buffer.from(match[2].replace(/[\r\n]/g, ''), 'base64')
    };
};

const syncDocumentFileToBackend = async (
    previewClientId: string | null,
    rawKey: string,
    data: unknown
): Promise<boolean> => {
    const key = canonicalStorageKey(rawKey);
    const fileKey = getDocumentFileKey(key);

    if (!previewClientId || !isDocumentFileKey(key) || !fileKey) {
        return false;
    }

    const config = getBackendConfig();
    const url = `${config.apiUrl}/api/document-files/legacy?clientId=${encodeURIComponent(previewClientId)}&fileKey=${encodeURIComponent(fileKey)}`;

    try {
        if (data === null) {
            const response = await fetch(url, {
                method: 'DELETE',
                headers: getBackendHeaders()
            });

            return response.ok;
        }

        const parsed = parseDataUrl(data);

        if (!parsed) {
            return false;
        }

        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                ...getBackendHeaders(),
                'Content-Type': 'application/octet-stream',
                'x-file-mime-type': parsed.mimeType
            },
            body: new Uint8Array(parsed.data)
        });

        if (!response.ok) {
            console.error(`Backend document file вернул статус ${response.status}`);
            return false;
        }

        return true;
    } catch (error) {
        console.error(`Ошибка защищенного сохранения файла ${key}:`, error);
        return false;
    }
};

const readAndMigrateLegacyDocumentFile = async (
    previewClientId: string | null,
    rawKey: string
): Promise<unknown | null> => {
    if (!previewClientId || !isDocumentFileKey(rawKey)) {
        return null;
    }

    const safeKey = sanitizeKey(rawKey);
    const filePath = path.join(dataDir, `${safeKey}.json`);

    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const legacyValue = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const migrated = await syncDocumentFileToBackend(previewClientId, rawKey, legacyValue);

        if (migrated) {
            fs.unlinkSync(filePath);
        }

        return legacyValue;
    } catch (error) {
        console.error(`Ошибка переноса старого файла ${rawKey}:`, error);
        return null;
    }
};

const syncTestProgressToBackend = async (
    previewClientId: string | null,
    rawKey: string,
    data: any
): Promise<boolean> => {
    const key = canonicalStorageKey(rawKey);

    if (!previewClientId || !isTestProgressKey(key) || !Array.isArray(data)) {
        return false;
    }

    const config = getBackendConfig();
    const userId = getTestProgressUserId(key);

    return postBackendJson(
        `${config.apiUrl}/api/test-attempts/legacy-passed`,
        {
            clientId: previewClientId,
            userId,
            passedTestSlugs: data
        },
        `прогресса тестов ${key}`
    );
};

const syncAuthoritativeBackendStorageValue = async (
    previewClientId: string | null,
    rawKey: string,
    data: any
): Promise<boolean | null> => {
    const key = canonicalStorageKey(rawKey);

    if (key === 'tea_hub_dynamic_route_v2') {
        return syncLearningRouteToBackend(previewClientId, data);
    }

    if (key === 'tea_hub_dynamic_tests_v1') {
        return syncLearningTestsToBackend(previewClientId, data);
    }

    if (key === 'tea_hub_urgent_files_v1') {
        return syncDocumentsToBackend(previewClientId, data);
    }

    if (key === 'tea_hub_notifications_v1') {
        return syncNotificationsToBackend(previewClientId, key, data);
    }

    if (key === 'tea_hub_push_subs_v1') {
        return syncPushSubscriptionsToBackend(previewClientId, key, data);
    }

    if (isProfileDataKey(key)) {
        return syncProfileDataToBackend(previewClientId, key, data);
    }

    if (key === 'admin_cal_notes_v1') {
        return syncAdminCalendarNotesToBackend(previewClientId, key, data);
    }

    if (isDismissedTasksKey(key)) {
        return syncDismissedTasksToBackend(previewClientId, key, data);
    }

    if (isRouteProgressKey(key)) {
        return syncRouteProgressToBackend(previewClientId, key, data);
    }

    if (isTestProgressKey(key)) {
        return syncTestProgressToBackend(previewClientId, key, data);
    }

    if (isClientContentKey(key)) {
        return syncClientContentToBackend(previewClientId, key, data);
    }

    return null;
};

export async function GET(request: Request) {
    const requestUrl = new URL(request.url);
    const { searchParams } = requestUrl;
    const rawKey = searchParams.get('key');
    const rawKeys = searchParams.get('keys');
    const previewClientId = resolvePreviewClientId(request, requestUrl);

    if (!rawKey && !rawKeys) {
        return NextResponse.json({ error: 'Не указан ключ данных' }, { status: 400 });
    }

    try {
        ensureDataDir();

        if (rawKeys) {
            const keys = rawKeys
                .split(',')
                .map((key) => key.trim())
                .filter(Boolean);

            const result: Record<string, any> = {};

            for (const key of keys) {
                try {
                    const canonicalKey = canonicalStorageKey(key);

                    if (isBlockedStorageKey(key) || isBlockedStorageKey(canonicalKey)) {
                        result[key] = [];
                        continue;
                    }

                    const backendValue = await fetchBackendStorageValue(canonicalKey, previewClientId);

                    if (backendValue === null && isDocumentFileKey(canonicalKey)) {
                        result[key] = await readAndMigrateLegacyDocumentFile(
                            previewClientId,
                            canonicalKey
                        );
                        continue;
                    }

                    result[key] = backendValue !== null
                        ? backendValue
                        : isAiHistoryKey(canonicalKey)
                            ? []
                            : readStorageValue(canonicalKey);
                } catch (error) {
                    console.error(`Ошибка чтения ключа ${key}:`, error);
                    result[key] = [];
                }
            }

            return NextResponse.json(result, {
                status: 200,
                headers: {
                    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                },
            });
        }

        const canonicalKey = canonicalStorageKey(rawKey as string);

        if (isBlockedStorageKey(rawKey as string) || isBlockedStorageKey(canonicalKey)) {
            return NextResponse.json([], {
                status: 200,
                headers: {
                    'Cache-Control': 'no-store'
                }
            });
        }

        const backendValue = await fetchBackendStorageValue(canonicalKey, previewClientId);

        if (backendValue !== null) {
            return new NextResponse(JSON.stringify(backendValue), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store',
                },
            });
        }

        if (isAiHistoryKey(canonicalKey)) {
            return NextResponse.json([], {
                status: 200,
                headers: {
                    'Cache-Control': 'no-store'
                }
            });
        }

        if (isDocumentFileKey(canonicalKey)) {
            const legacyFileValue = await readAndMigrateLegacyDocumentFile(
                previewClientId,
                canonicalKey
            );

            return NextResponse.json(legacyFileValue, {
                status: 200,
                headers: {
                    'Cache-Control': 'private, no-store'
                }
            });
        }

        const safeKey = sanitizeKey(canonicalKey);
        const filePath = path.join(dataDir, `${safeKey}.json`);

        if (fs.existsSync(filePath)) {
            const fileData = fs.readFileSync(filePath, 'utf8');
            return new NextResponse(fileData, {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                },
            });
        } else {
            const storageValue = readStorageValue(canonicalKey);

            return new NextResponse(JSON.stringify(storageValue), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store',
                },
            });
        }
    } catch (error) {
        console.error('Ошибка чтения:', error);
        return NextResponse.json([], { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { key: rawKey, data } = body;

        if (!rawKey || !Object.prototype.hasOwnProperty.call(body, 'data')) {
            return NextResponse.json({ error: 'Неверные данные' }, { status: 400 });
        }

        const previewClientId = resolvePreviewClientId(request, new URL(request.url));
        const canonicalKey = canonicalStorageKey(rawKey);

        if (isBlockedStorageKey(rawKey) || isBlockedStorageKey(canonicalKey)) {
            return NextResponse.json(
                { error: 'Этот неподтвержденный раздел отключен' },
                { status: 410 }
            );
        }

        if (isAiHistoryKey(canonicalKey)) {
            const savedSecurely = await syncAiHistoryToBackend(previewClientId, canonicalKey, data);

            if (!savedSecurely) {
                return NextResponse.json(
                    { error: 'Не удалось безопасно сохранить историю AI' },
                    { status: 502 }
                );
            }

            return NextResponse.json({ success: true, storage: 'encrypted-postgresql' });
        }

        if (isDocumentFileKey(canonicalKey)) {
            const savedSecurely = await syncDocumentFileToBackend(
                previewClientId,
                canonicalKey,
                data
            );

            if (!savedSecurely) {
                return NextResponse.json(
                    { error: 'Не удалось безопасно сохранить файл' },
                    { status: 502 }
                );
            }

            return NextResponse.json({ success: true, storage: 'encrypted-private-storage' });
        }

        const authoritativeBackendResult = await syncAuthoritativeBackendStorageValue(
            previewClientId,
            canonicalKey,
            data
        );

        if (authoritativeBackendResult !== null) {
            if (!authoritativeBackendResult) {
                return NextResponse.json(
                    { error: 'Backend не принял данные' },
                    { status: 502 }
                );
            }

            return NextResponse.json({ success: true, storage: 'postgresql' });
        }

        if (canonicalKey === 'tea_hub_users_v1') {
            await syncUsersToBackend(previewClientId, data);
        }

        if (canonicalKey === 'tea_hub_test_results_v1') {
            await syncTestResultsToBackend(previewClientId, canonicalKey, data);
        }

        const safeKey = sanitizeKey(canonicalKey);
        const filePath = path.join(dataDir, `${safeKey}.json`);
        
        ensureDataDir();

        // Записываем данные в локальный файл
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        console.log(`OK [УСПЕХ] Файл сохранен: ${filePath}`);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error(' Ошибка записи:', error);
        return NextResponse.json({ error: 'Ошибка сервера' }, { status: 500 });
    }
}
