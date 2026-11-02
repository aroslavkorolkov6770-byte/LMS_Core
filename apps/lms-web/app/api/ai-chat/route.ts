import { NextResponse } from 'next/server';

export async function POST(request: Request) {
    const body = await request.json();
    const { messages } = body; 

    const API_KEY = process.env.NEXT_PUBLIC_AI_API_KEY; 

    try {
        const response = await fetch("https://ai.api.cloud.yandex.net/v1/responses", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`, 
                'OpenAI-Project': 'b1g1k18evi08k4r17n9h' 
            },
            body: JSON.stringify({
                prompt: {
                    id: 'fvt57g2r89qkgi1p7cb3'
                },
                // Передаем чистый массив истории, без склеивания в один текст!
                input: messages 
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("Ошибка от API Яндекса:", errorText);
            return NextResponse.json({ error: `Ошибка Яндекса ${response.status}`, details: errorText }, { status: response.status });
        }

        const data = await response.json();
        return NextResponse.json(data);
    } catch (error) {
        console.error("Внутренняя ошибка сервера:", error);
        return NextResponse.json({ error: 'Внутренняя ошибка сервера' }, { status: 500 });
    }
}