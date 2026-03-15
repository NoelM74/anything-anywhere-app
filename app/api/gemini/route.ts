import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'API key not configured' }, { status: 500 });
  }

  let body: { imageData?: string; mimeType?: string; prompt?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { imageData, mimeType, prompt } = body;
  if (!imageData || !mimeType || !prompt) {
    return NextResponse.json({ error: 'Missing required fields: imageData, mimeType, prompt' }, { status: 400 });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [
          { inlineData: { data: imageData, mimeType } },
          { text: prompt },
        ],
      },
    });

    const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!imagePart?.inlineData) {
      return NextResponse.json({ error: 'No image returned from model' }, { status: 502 });
    }

    return NextResponse.json({
      imageData: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType,
    });
  } catch (error) {
    console.error('Gemini API error:', error);
    return NextResponse.json({ error: 'Failed to process image' }, { status: 500 });
  }
}
