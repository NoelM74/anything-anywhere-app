'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Trash2, Download, Image as ImageIcon, Plus, Loader2, ArrowLeft, Move, Settings2, Eraser, Maximize2, Minimize2, X } from 'lucide-react';
import { GoogleGenAI } from '@google/genai';

declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

type ElementData = {
  id: string;
  src: string;
  brightness: number;
  contrast: number;
  originalWidth?: number;
  originalHeight?: number;
  isRemovingBackground?: boolean;
};

type CanvasElementData = ElementData & {
  canvasId: string;
  scale: number;
  x: number;
  y: number;
  isRemovingBackground?: boolean;
};

export default function Page() {
  const [hasKey, setHasKey] = useState(false);
  const [isCheckingKey, setIsCheckingKey] = useState(true);

  const [backgroundImage, setBackgroundImage] = useState<string | null>(null);
  const [elements, setElements] = useState<ElementData[]>([]);
  const [canvasElements, setCanvasElements] = useState<CanvasElementData[]>([]);
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [editingElementId, setEditingElementId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [snapGuides, setSnapGuides] = useState<{ type: 'vertical' | 'horizontal', position: number }[]>([]);

  const bgImgRef = useRef<HTMLImageElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const elementsInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const checkKey = async () => {
      if (window.aistudio?.hasSelectedApiKey) {
        const has = await window.aistudio.hasSelectedApiKey();
        setHasKey(has);
      } else {
        setHasKey(true);
      }
      setIsCheckingKey(false);
    };
    checkKey();
  }, []);

  const handleSelectKey = async () => {
    if (window.aistudio?.openSelectKey) {
      await window.aistudio.openSelectKey();
      setHasKey(true);
    }
  };

  const handleBackgroundUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => setBackgroundImage(e.target?.result as string);
      reader.readAsDataURL(file);
    }
  };

  const handleElementsUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const src = e.target?.result as string;
        const img = new Image();
        img.onload = () => {
          setElements(prev => {
            const newEl: ElementData = { 
              id: Math.random().toString(36).substring(7), 
              src: src,
              brightness: 100,
              contrast: 100,
              originalWidth: img.naturalWidth,
              originalHeight: img.naturalHeight
            };
            return [...prev, newEl].slice(0, 10);
          });
        };
        img.src = src;
      };
      reader.readAsDataURL(file);
    });
  };

  const updateElementFilter = (id: string, type: 'brightness' | 'contrast', value: number) => {
    setElements(prev => prev.map(el => el.id === id ? { ...el, [type]: value } : el));
    setCanvasElements(prev => prev.map(el => el.id === id ? { ...el, [type]: value } : el));
  };

  const deleteElement = (id: string) => {
    setElements(prev => prev.filter(el => el.id !== id));
    setCanvasElements(prev => prev.filter(el => el.id !== id));
    if (editingElementId === id) setEditingElementId(null);
  };

  const removeElementBackground = async (id: string) => {
    const el = elements.find(e => e.id === id);
    if (!el) return;

    setElements(prev => prev.map(e => e.id === id ? { ...e, isRemovingBackground: true } : e));

    try {
      const base64Data = el.src.split(',')[1];
      const mimeType = el.src.split(';')[0].split(':')[1];

      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: mimeType,
              },
            },
            {
              text: 'Extract the main subject of the image and place it on a pure, solid magenta background (Hex: #FF00FF). CRITICAL: DO NOT use a checkerboard or grid pattern. The background must be completely solid magenta.',
            },
          ],
        },
      });

      let newImageUrl = null;
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          newImageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          break;
        }
      }

      if (newImageUrl) {
        // Process the image to remove the magenta background
        const processedImageUrl = await new Promise<string>((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = "Anonymous";
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              resolve(newImageUrl!);
              return;
            }
            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            const width = canvas.width;
            const height = canvas.height;
            
            const visited = new Uint8Array(width * height);
            const stack: [number, number][] = [];
            
            const isMagenta = (r: number, g: number, b: number) => r > 200 && g < 100 && b > 200;
            
            for (let x = 0; x < width; x++) {
              stack.push([x, 0]);
              stack.push([x, height - 1]);
            }
            for (let y = 0; y < height; y++) {
              stack.push([0, y]);
              stack.push([width - 1, y]);
            }
            
            while (stack.length > 0) {
              const [x, y] = stack.pop()!;
              if (x < 0 || x >= width || y < 0 || y >= height) continue;
              
              const vIdx = y * width + x;
              if (visited[vIdx]) continue;
              
              const idx = vIdx * 4;
              const r = data[idx];
              const g = data[idx + 1];
              const b = data[idx + 2];
              
              if (isMagenta(r, g, b)) {
                visited[vIdx] = 1;
                data[idx + 3] = 0;
                stack.push([x + 1, y]);
                stack.push([x - 1, y]);
                stack.push([x, y + 1]);
                stack.push([x, y - 1]);
              }
            }
            
            // Global pass for pure magenta just in case
            for (let i = 0; i < data.length; i += 4) {
              if (data[i] > 240 && data[i+1] < 20 && data[i+2] > 240) {
                 data[i+3] = 0;
              }
            }

            ctx.putImageData(imageData, 0, 0);
            resolve(canvas.toDataURL('image/png'));
          };
          img.onerror = reject;
          img.src = newImageUrl!;
        });

        setElements(prev => prev.map(e => e.id === id ? { ...e, src: processedImageUrl, isRemovingBackground: false } : e));
        setCanvasElements(prev => prev.map(e => e.id === id ? { ...e, src: processedImageUrl } : e));
      } else {
        throw new Error("No image returned");
      }
    } catch (error) {
      console.error("Failed to remove background:", error);
      alert("Failed to remove background. Please try again.");
      setElements(prev => prev.map(e => e.id === id ? { ...e, isRemovingBackground: false } : e));
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const elementId = e.dataTransfer.getData('elementId');
    const element = elements.find(el => el.id === elementId);
    if (element) {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const initialScale = element.originalWidth && element.originalHeight 
        ? Math.min(150 / element.originalWidth, 150 / element.originalHeight, 1)
        : 1;

      const w = element.originalWidth || 150;
      const h = element.originalHeight || 150;

      const newCanvasElement: CanvasElementData = {
        ...element,
        canvasId: Math.random().toString(36).substring(7),
        scale: initialScale,
        x: x - (w / 2),
        y: y - (h / 2),
      };
      
      setCanvasElements(prev => [...prev, newCanvasElement]);
      setSelectedElementId(newCanvasElement.canvasId);
    }
  };

  const bringToFront = (canvasId: string) => {
    setCanvasElements(prev => {
      const el = prev.find(e => e.canvasId === canvasId);
      if (!el) return prev;
      return [...prev.filter(e => e.canvasId !== canvasId), el];
    });
  };

  const updateScale = (canvasId: string, scale: number) => {
    setCanvasElements(prev => prev.map(el => el.canvasId === canvasId ? { ...el, scale } : el));
  };

  const removeCanvasElement = (canvasId: string) => {
    setCanvasElements(prev => prev.filter(el => el.canvasId !== canvasId));
    if (selectedElementId === canvasId) setSelectedElementId(null);
  };

  const handlePointerDown = (e: React.PointerEvent, canvasId: string) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedElementId(canvasId);
    bringToFront(canvasId);
    
    const elNode = document.getElementById(`canvas-el-${canvasId}`);
    if (!elNode) return;
    
    const rect = elNode.getBoundingClientRect();
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    });
    setDraggingId(canvasId);
  };

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      if (!draggingId || !bgImgRef.current) return;
      
      const bgRect = bgImgRef.current.getBoundingClientRect();
      const elNode = document.getElementById(`canvas-el-${draggingId}`);
      if (!elNode) return;
      
      let newScaledX = e.clientX - dragOffset.x - bgRect.left;
      let newScaledY = e.clientY - dragOffset.y - bgRect.top;
      
      const elRect = elNode.getBoundingClientRect();
      const width = elRect.width;
      const height = elRect.height;
      
      const SNAP_THRESHOLD = 15;
      const guides: { type: 'vertical' | 'horizontal', position: number }[] = [];
      
      // Snap to background edges
      if (Math.abs(newScaledX) < SNAP_THRESHOLD) { newScaledX = 0; guides.push({ type: 'vertical', position: 0 }); }
      else if (Math.abs(newScaledX + width - bgRect.width) < SNAP_THRESHOLD) { newScaledX = bgRect.width - width; guides.push({ type: 'vertical', position: bgRect.width }); }
      else if (Math.abs(newScaledX + width/2 - bgRect.width/2) < SNAP_THRESHOLD) { newScaledX = bgRect.width/2 - width/2; guides.push({ type: 'vertical', position: bgRect.width/2 }); }
      
      if (Math.abs(newScaledY) < SNAP_THRESHOLD) { newScaledY = 0; guides.push({ type: 'horizontal', position: 0 }); }
      else if (Math.abs(newScaledY + height - bgRect.height) < SNAP_THRESHOLD) { newScaledY = bgRect.height - height; guides.push({ type: 'horizontal', position: bgRect.height }); }
      else if (Math.abs(newScaledY + height/2 - bgRect.height/2) < SNAP_THRESHOLD) { newScaledY = bgRect.height/2 - height/2; guides.push({ type: 'horizontal', position: bgRect.height/2 }); }
      
      // Snap to other elements
      canvasElements.forEach(otherEl => {
        if (otherEl.canvasId === draggingId) return;
        const otherNode = document.getElementById(`canvas-el-${otherEl.canvasId}`);
        if (!otherNode) return;
        
        const otherRect = otherNode.getBoundingClientRect();
        const otherX = otherRect.left - bgRect.left;
        const otherY = otherRect.top - bgRect.top;
        const otherWidth = otherRect.width;
        const otherHeight = otherRect.height;
        
        if (Math.abs(newScaledX - otherX) < SNAP_THRESHOLD) { newScaledX = otherX; guides.push({ type: 'vertical', position: otherX }); }
        else if (Math.abs((newScaledX + width) - (otherX + otherWidth)) < SNAP_THRESHOLD) { newScaledX = otherX + otherWidth - width; guides.push({ type: 'vertical', position: otherX + otherWidth }); }
        else if (Math.abs((newScaledX + width/2) - (otherX + otherWidth/2)) < SNAP_THRESHOLD) { newScaledX = otherX + otherWidth/2 - width/2; guides.push({ type: 'vertical', position: otherX + otherWidth/2 }); }
        else if (Math.abs(newScaledX - (otherX + otherWidth)) < SNAP_THRESHOLD) { newScaledX = otherX + otherWidth; guides.push({ type: 'vertical', position: otherX + otherWidth }); }
        else if (Math.abs((newScaledX + width) - otherX) < SNAP_THRESHOLD) { newScaledX = otherX - width; guides.push({ type: 'vertical', position: otherX }); }
        
        if (Math.abs(newScaledY - otherY) < SNAP_THRESHOLD) { newScaledY = otherY; guides.push({ type: 'horizontal', position: otherY }); }
        else if (Math.abs((newScaledY + height) - (otherY + otherHeight)) < SNAP_THRESHOLD) { newScaledY = otherY + otherHeight - height; guides.push({ type: 'horizontal', position: otherY + otherHeight }); }
        else if (Math.abs((newScaledY + height/2) - (otherY + otherHeight/2)) < SNAP_THRESHOLD) { newScaledY = otherY + otherHeight/2 - height/2; guides.push({ type: 'horizontal', position: otherY + otherHeight/2 }); }
        else if (Math.abs(newScaledY - (otherY + otherHeight)) < SNAP_THRESHOLD) { newScaledY = otherY + otherHeight; guides.push({ type: 'horizontal', position: otherY + otherHeight }); }
        else if (Math.abs((newScaledY + height) - otherY) < SNAP_THRESHOLD) { newScaledY = otherY - height; guides.push({ type: 'horizontal', position: otherY }); }
      });
      
      setSnapGuides(guides);
      
      const el = canvasElements.find(e => e.canvasId === draggingId);
      const baseW = el?.originalWidth || 150;
      const baseH = el?.originalHeight || 150;
      
      const unscaledX = newScaledX - (baseW - width) / 2;
      const unscaledY = newScaledY - (baseH - height) / 2;
      
      setCanvasElements(prev => prev.map(el => 
        el.canvasId === draggingId ? { ...el, x: unscaledX, y: unscaledY } : el
      ));
    };
    
    const handlePointerUp = () => {
      setDraggingId(null);
      setSnapGuides([]);
    };
    
    if (draggingId) {
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    }
    
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [draggingId, dragOffset, canvasElements]);

  const removeBackground = async (canvasId: string) => {
    const el = canvasElements.find(e => e.canvasId === canvasId);
    if (!el) return;

    setCanvasElements(prev => prev.map(e => e.canvasId === canvasId ? { ...e, isRemovingBackground: true } : e));

    try {
      const base64Data = el.src.split(',')[1];
      const mimeType = el.src.split(';')[0].split(':')[1];

      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: mimeType,
              },
            },
            {
              text: 'Extract the main subject of the image and remove the background. Output the result as a PNG image with a TRUE transparent background (alpha channel = 0). CRITICAL: DO NOT output a checkerboard or grid pattern. The background must be completely clear and transparent.',
            },
          ],
        },
      });

      let newImageUrl = null;
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          newImageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          break;
        }
      }

      if (newImageUrl) {
        setCanvasElements(prev => prev.map(e => e.canvasId === canvasId ? { ...e, src: newImageUrl, isRemovingBackground: false } : e));
      } else {
        throw new Error("No image returned");
      }
    } catch (error) {
      console.error("Failed to remove background:", error);
      alert("Failed to remove background. Please try again.");
      setCanvasElements(prev => prev.map(e => e.canvasId === canvasId ? { ...e, isRemovingBackground: false } : e));
    }
  };

  const generateComposite = async () => {
    if (!bgImgRef.current) return;
    
    setIsGenerating(true);
    try {
      const bgRect = bgImgRef.current.getBoundingClientRect();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error("Could not get canvas context");

      const naturalWidth = bgImgRef.current.naturalWidth;
      const naturalHeight = bgImgRef.current.naturalHeight;
      canvas.width = naturalWidth;
      canvas.height = naturalHeight;

      const scaleX = naturalWidth / bgRect.width;
      const scaleY = naturalHeight / bgRect.height;

      ctx.drawImage(bgImgRef.current, 0, 0, naturalWidth, naturalHeight);

      for (const el of canvasElements) {
        const elNode = document.getElementById(`canvas-el-${el.canvasId}`);
        const imgNode = elNode?.querySelector('img');
        if (!imgNode) continue;

        const elRect = imgNode.getBoundingClientRect();
        
        const relativeX = elRect.left - bgRect.left;
        const relativeY = elRect.top - bgRect.top;

        const drawX = relativeX * scaleX;
        const drawY = relativeY * scaleY;
        const drawWidth = elRect.width * scaleX;
        const drawHeight = elRect.height * scaleY;

        ctx.save();
        ctx.filter = `brightness(${el.brightness}%) contrast(${el.contrast}%)`;
        ctx.drawImage(imgNode, drawX, drawY, drawWidth, drawHeight);
        ctx.restore();
      }

      const base64DataUrl = canvas.toDataURL('image/jpeg', 0.9);
      const base64Data = base64DataUrl.split(',')[1];

      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: 'image/jpeg',
              },
            },
            {
              text: 'This image contains a background and several elements overlaid on top of it. Please blend the overlaid elements naturally into the background. CRITICAL INSTRUCTIONS: 1. DO NOT change the original background image in any way (do not turn on lights, do not change the time of day, do not alter the room). 2. DO NOT change the appearance, color, or texture of the elements being added. 3. DO NOT project shadows or light patterns onto the elements (e.g., do not add window shadows across the sofa). 4. Only add subtle contact shadows underneath or behind the elements to ground them in the scene. 5. The final image must look exactly like the layout image, but with realistic contact shadows.',
            },
          ],
        },
      });

      let newImageUrl = null;
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          newImageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          break;
        }
      }

      if (newImageUrl) {
        setGeneratedImage(newImageUrl);
      } else {
        throw new Error("No image returned from Gemini");
      }

    } catch (error) {
      console.error("Generation failed:", error);
      alert("Failed to generate image. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  };

  const downloadImage = () => {
    if (!generatedImage) return;
    const a = document.createElement('a');
    a.href = generatedImage;
    a.download = 'blended-image.jpg';
    a.click();
  };

  if (isCheckingKey) {
    return <div className="flex h-screen items-center justify-center bg-[#f5f5f5]"><Loader2 className="animate-spin text-gray-400" size={32} /></div>;
  }

  if (!hasKey) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#f5f5f5]">
        <div className="bg-white p-8 rounded-3xl shadow-xl max-w-md w-full text-center border border-gray-100">
          <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <ImageIcon className="text-gray-900" size={32} />
          </div>
          <h2 className="text-2xl font-bold mb-3 tracking-tight">API Key Required</h2>
          <p className="text-gray-500 mb-8 leading-relaxed text-sm">
            This app uses the Gemini 2.5 Flash Image model for fast, high-quality blending and background removal, which requires a paid Google Cloud project API key.
            <br/><br/>
            <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-700 font-medium hover:underline">Learn more about billing</a>
          </p>
          <button 
            onClick={handleSelectKey}
            className="bg-gray-900 text-white px-6 py-3.5 rounded-full font-semibold hover:bg-gray-800 transition-all w-full shadow-lg shadow-gray-900/20 active:scale-[0.98]"
          >
            Select API Key
          </button>
        </div>
      </div>
    );
  }

  const editingElement = elements.find(e => e.id === editingElementId);

  return (
    <div className="flex h-screen bg-[#f5f5f5] font-sans text-gray-900 overflow-hidden">
      {/* Sidebar */}
      <div className="w-80 bg-white border-r border-gray-200 flex flex-col h-full shadow-sm z-10 shrink-0">
        <div className="p-6 border-b border-gray-100">
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            ANYTHING <span className="font-light italic text-gray-500">anywhere</span>
            <span className="bg-gray-900 text-white text-[10px] font-black px-1.5 py-0.5 rounded uppercase tracking-widest ml-1">3D</span>
          </h1>
        </div>
        
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {/* Setting Section */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-bold tracking-widest text-gray-400 uppercase">Setting</h2>
            </div>
            
            <input 
              type="file" 
              accept="image/*" 
              className="hidden" 
              ref={fileInputRef}
              onChange={handleBackgroundUpload}
            />
            
            {backgroundImage ? (
              <div className="relative group rounded-xl overflow-hidden border border-gray-200 aspect-[4/3]">
                <img src={backgroundImage} alt="Setting" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="bg-white text-gray-900 px-4 py-2 rounded-full text-sm font-medium shadow-lg hover:bg-gray-50 transition-colors"
                  >
                    Change
                  </button>
                </div>
              </div>
            ) : (
              <button 
                onClick={() => fileInputRef.current?.click()}
                className="w-full aspect-[4/3] rounded-xl border-2 border-dashed border-gray-300 hover:border-gray-400 hover:bg-gray-50 transition-colors flex flex-col items-center justify-center text-gray-500 gap-2"
              >
                <ImageIcon size={24} />
                <span className="text-sm font-medium">Upload Background</span>
              </button>
            )}
          </section>

          {/* Elements Section */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-bold tracking-widest text-gray-400 uppercase">Elements</h2>
              <span className="text-xs font-medium text-gray-400">{elements.length}/10</span>
            </div>
            
            <input 
              type="file" 
              accept="image/*" 
              multiple
              className="hidden" 
              ref={elementsInputRef}
              onChange={handleElementsUpload}
            />

            <div className="grid grid-cols-2 gap-3">
              {elements.map((el) => (
                <div 
                  key={el.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('elementId', el.id)}
                  className="aspect-square rounded-xl border border-gray-200 overflow-hidden cursor-grab active:cursor-grabbing hover:ring-2 hover:ring-blue-500 hover:ring-offset-1 transition-all bg-gray-50 flex items-center justify-center group relative"
                >
                  <img 
                    src={el.src} 
                    alt="Element" 
                    className="max-w-full max-h-full object-contain p-2" 
                    style={{ filter: `brightness(${el.brightness}%) contrast(${el.contrast}%)` }}
                  />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                    <button 
                      onClick={(e) => { e.stopPropagation(); setEditingElementId(el.id); }}
                      className="p-2 bg-white rounded-full text-gray-900 hover:bg-gray-100 shadow-sm"
                      title="Adjust Filters"
                    >
                      <Settings2 size={16} />
                    </button>
                  </div>
                  {el.isRemovingBackground && (
                    <div className="absolute inset-0 bg-white/50 flex items-center justify-center">
                      <Loader2 className="animate-spin text-gray-900" size={24} />
                    </div>
                  )}
                </div>
              ))}
              
              {elements.length < 10 && (
                <button 
                  onClick={() => elementsInputRef.current?.click()}
                  className="aspect-square rounded-xl border-2 border-dashed border-gray-300 hover:border-gray-400 hover:bg-gray-50 transition-colors flex flex-col items-center justify-center text-gray-400 gap-1"
                >
                  <Plus size={20} />
                  <span className="text-xs font-medium">Add</span>
                </button>
              )}
            </div>
            {elements.length > 0 && (
              <p className="text-xs text-gray-400 mt-3 text-center">Drag elements onto the canvas</p>
            )}
          </section>
        </div>
      </div>

      {/* Main Area */}
      <div className="flex-1 relative flex flex-col overflow-hidden">
        {isGenerating ? (
          <div className="flex-1 flex flex-col items-center justify-center bg-white/50 backdrop-blur-sm z-50">
            <Loader2 size={48} className="animate-spin text-blue-600 mb-4" />
            <h3 className="text-xl font-medium text-gray-900">Blending Elements...</h3>
            <p className="text-center text-gray-500 mt-2 max-w-sm">
              Using Gemini 2.5 Flash Image to seamlessly blend elements into the background.
            </p>
          </div>
        ) : generatedImage ? (
          <div className="flex-1 flex flex-col p-8 overflow-y-auto">
            <div className="flex items-center justify-between mb-6 shrink-0">
              <button 
                onClick={() => setGeneratedImage(null)}
                className="flex items-center gap-2 text-gray-600 hover:text-gray-900 font-medium transition-colors"
              >
                <ArrowLeft size={20} /> Back to Edit
              </button>
              <div className="flex items-center gap-3">
                <button 
                  onClick={() => setIsFullscreen(true)}
                  className="flex items-center gap-2 bg-white text-gray-900 border border-gray-200 px-4 py-2.5 rounded-full font-medium hover:bg-gray-50 transition-colors shadow-sm"
                >
                  <Maximize2 size={18} /> View Full
                </button>
                <button 
                  onClick={downloadImage}
                  className="flex items-center gap-2 bg-gray-900 text-white px-5 py-2.5 rounded-full font-medium hover:bg-gray-800 transition-colors shadow-md"
                >
                  <Download size={18} /> Download Image
                </button>
              </div>
            </div>
            <div className="flex-1 bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden flex items-center justify-center p-4 min-h-0">
              <img src={generatedImage} alt="Generated" className="max-w-full max-h-full object-contain rounded-lg" />
            </div>
          </div>
        ) : backgroundImage ? (
          <>
            <div className="flex-1 flex flex-col p-4 relative overflow-y-auto bg-gray-100">
              <div className="m-auto relative shadow-2xl rounded-lg">
                <img 
                  ref={bgImgRef}
                  src={backgroundImage} 
                  className="block max-w-full w-auto h-auto rounded-lg" 
                  alt="Background" 
                  draggable={false}
                />
                <div 
                  className="absolute inset-0 overflow-hidden rounded-lg"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleDrop}
                  onClick={() => setSelectedElementId(null)}
                >
                  {/* Snap Guides */}
                  {snapGuides.map((guide, i) => (
                    <div
                      key={`guide-${i}`}
                      className="absolute bg-blue-500 z-40 pointer-events-none"
                      style={{
                        ...(guide.type === 'vertical' 
                          ? { left: guide.position, top: 0, bottom: 0, width: 1 }
                          : { top: guide.position, left: 0, right: 0, height: 1 }
                        )
                      }}
                    />
                  ))}
                  {canvasElements.map(el => {
                    const isSelected = selectedElementId === el.canvasId;
                    return (
                      <div
                        key={el.canvasId}
                        id={`canvas-el-${el.canvasId}`}
                        onPointerDown={(e) => handlePointerDown(e, el.canvasId)}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: el.originalWidth || 150,
                          height: el.originalHeight || 150,
                          transform: `translate(${el.x}px, ${el.y}px) scale(${el.scale})`,
                          transformOrigin: 'center',
                          zIndex: isSelected ? 50 : 10,
                          cursor: draggingId === el.canvasId ? 'grabbing' : 'grab',
                          touchAction: 'none'
                        }}
                        className={`flex items-center justify-center ${isSelected ? 'ring-2 ring-blue-500 ring-offset-2 rounded-lg bg-white/10 backdrop-blur-[2px]' : ''}`}
                      >
                        <img 
                          src={el.src} 
                          alt="" 
                          className={`max-w-full max-h-full object-contain pointer-events-none drop-shadow-lg ${el.isRemovingBackground ? 'opacity-50 blur-sm' : ''}`} 
                          style={{ filter: `brightness(${el.brightness}%) contrast(${el.contrast}%)` }}
                        />
                        {el.isRemovingBackground && (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <Loader2 className="animate-spin text-gray-900 drop-shadow-md" size={32} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Floating Toolbar for Selected Element */}
            {selectedElementId && (
              <div className="absolute bottom-24 left-1/2 -translate-x-1/2 bg-white/95 backdrop-blur-md rounded-full shadow-xl px-6 py-3 flex items-center gap-4 z-50 border border-gray-200">
                <span className="text-sm font-semibold text-gray-700 uppercase tracking-wider">Scale</span>
                <input 
                  type="range" 
                  min="0.1" 
                  max="2" 
                  step="0.01" 
                  value={canvasElements.find(e => e.canvasId === selectedElementId)?.scale || 1}
                  onChange={(e) => updateScale(selectedElementId, parseFloat(e.target.value))}
                  className="w-24 accent-gray-900"
                />
                <span className="text-sm font-medium text-gray-600 w-12 text-right">
                  {Math.round((canvasElements.find(e => e.canvasId === selectedElementId)?.scale || 1) * 100)}%
                </span>
                <button
                  onClick={() => updateScale(selectedElementId, 1)}
                  className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-xs font-bold rounded-md transition-colors text-gray-700"
                >
                  100%
                </button>
                <div className="w-px h-6 bg-gray-200"></div>
                <button 
                  onClick={() => removeBackground(selectedElementId)}
                  disabled={canvasElements.find(e => e.canvasId === selectedElementId)?.isRemovingBackground}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900 transition-colors disabled:opacity-50"
                >
                  <Eraser size={16} />
                  Remove BG
                </button>
                <div className="w-px h-6 bg-gray-200"></div>
                <button 
                  onClick={() => removeCanvasElement(selectedElementId)}
                  className="text-red-500 hover:text-red-600 hover:bg-red-50 p-2 rounded-full transition-colors flex items-center justify-center"
                  title="Remove Element"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            )}

            {/* Generate Button */}
            <div className="absolute bottom-8 right-8 z-40">
              <button 
                onClick={generateComposite}
                disabled={canvasElements.length === 0}
                className="bg-gray-900 text-white px-8 py-4 rounded-full font-bold tracking-wide hover:bg-gray-800 transition-all shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                GENERATE
              </button>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
            <ImageIcon size={64} className="mb-4 opacity-20" />
            <h2 className="text-2xl font-medium text-gray-500">Start by uploading a setting</h2>
            <p className="mt-2">Use the sidebar to add your background image</p>
          </div>
        )}
      </div>

      {/* Edit Element Modal */}
      {editingElement && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl border border-gray-100 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between mb-4 shrink-0">
              <h3 className="text-lg font-bold tracking-tight">Adjust Element</h3>
              <button onClick={() => setEditingElementId(null)} className="text-gray-400 hover:text-gray-900 transition-colors p-1">
                <X size={20} />
              </button>
            </div>
            
            <div className="h-48 bg-gray-50 rounded-2xl mb-6 flex items-center justify-center p-4 border border-gray-100 shrink-0 relative overflow-hidden">
              <img 
                src={editingElement.src} 
                alt="Preview" 
                className={`max-w-full max-h-full object-contain ${editingElement.isRemovingBackground ? 'opacity-50 blur-sm' : ''}`}
                style={{ filter: `brightness(${editingElement.brightness}%) contrast(${editingElement.contrast}%)` }}
              />
              {editingElement.isRemovingBackground && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Loader2 className="animate-spin text-gray-900 drop-shadow-md" size={32} />
                </div>
              )}
            </div>

            <div className="space-y-5 overflow-y-auto pr-2 pb-2">
              <div className="flex gap-2">
                <button 
                  onClick={() => removeElementBackground(editingElement.id)}
                  disabled={editingElement.isRemovingBackground}
                  className="flex-1 flex items-center justify-center gap-2 bg-gray-100 hover:bg-gray-200 text-gray-800 py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
                >
                  <Eraser size={16} />
                  Remove BG
                </button>
                <button 
                  onClick={() => deleteElement(editingElement.id)}
                  className="flex items-center justify-center gap-2 bg-red-50 hover:bg-red-100 text-red-600 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
                  title="Delete Element"
                >
                  <Trash2 size={16} />
                </button>
              </div>

              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm font-semibold text-gray-700">Brightness</label>
                  <span className="text-sm text-gray-500">{editingElement.brightness}%</span>
                </div>
                <input 
                  type="range" 
                  min="0" 
                  max="200" 
                  value={editingElement.brightness}
                  onChange={(e) => updateElementFilter(editingElement.id, 'brightness', parseInt(e.target.value))}
                  className="w-full accent-gray-900"
                />
              </div>
              
              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm font-semibold text-gray-700">Contrast</label>
                  <span className="text-sm text-gray-500">{editingElement.contrast}%</span>
                </div>
                <input 
                  type="range" 
                  min="0" 
                  max="200" 
                  value={editingElement.contrast}
                  onChange={(e) => updateElementFilter(editingElement.id, 'contrast', parseInt(e.target.value))}
                  className="w-full accent-gray-900"
                />
              </div>
            </div>

            <div className="mt-6 shrink-0">
              <button 
                onClick={() => setEditingElementId(null)} 
                className="w-full bg-gray-900 text-white py-3 rounded-xl font-medium hover:bg-gray-800 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fullscreen Image Modal */}
      {isFullscreen && generatedImage && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <button 
            onClick={() => setIsFullscreen(false)}
            className="absolute top-6 right-6 text-white/70 hover:text-white bg-black/50 p-3 rounded-full transition-colors"
          >
            <Minimize2 size={24} />
          </button>
          <img 
            src={generatedImage} 
            alt="Generated Fullscreen" 
            className="max-w-full max-h-full object-contain"
          />
        </div>
      )}
    </div>
  );
}
