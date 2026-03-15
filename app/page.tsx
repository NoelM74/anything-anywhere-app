'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Trash2, Download, Image as ImageIcon, Plus, Minus, Loader2, ArrowLeft,
  Settings2, Eraser, Maximize2, Minimize2, X, Menu,
} from 'lucide-react';

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
};

type Toast = { id: string; message: string; type: 'error' | 'info' };

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function parseDataUrl(src: string) {
  return {
    data: src.split(',')[1],
    mimeType: src.split(';')[0].split(':')[1],
  };
}

async function callGemini(imageData: string, mimeType: string, prompt: string): Promise<string> {
  const res = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageData, mimeType, prompt }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Gemini API request failed');
  }
  const { imageData: data, mimeType: mime } = await res.json();
  return `data:${mime};base64,${data}`;
}

function removeMagentaBackground(imageUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(imageUrl); return; }
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const { width, height } = canvas;
      const workerSrc = `
        self.onmessage = function(e) {
          var buf = e.data.buffer, width = e.data.width, height = e.data.height;
          var data = new Uint8ClampedArray(buf);
          var isMagenta = function(r,g,b){ return r>200 && g<100 && b>200; };
          var visited = new Uint8Array(width * height);
          var stack = [];
          for (var x=0;x<width;x++){ stack.push(x,0); stack.push(x,height-1); }
          for (var y=0;y<height;y++){ stack.push(0,y); stack.push(width-1,y); }
          while (stack.length > 0) {
            var sy = stack.pop(), sx = stack.pop();
            if (sx<0||sx>=width||sy<0||sy>=height) continue;
            var vi = sy*width+sx;
            if (visited[vi]) continue;
            var i = vi*4;
            if (isMagenta(data[i],data[i+1],data[i+2])) {
              visited[vi]=1; data[i+3]=0;
              stack.push(sx+1,sy); stack.push(sx-1,sy);
              stack.push(sx,sy+1); stack.push(sx,sy-1);
            }
          }
          for (var j=0;j<data.length;j+=4) {
            if (data[j]>240 && data[j+1]<20 && data[j+2]>240) data[j+3]=0;
          }
          self.postMessage({ buffer: data.buffer }, [data.buffer]);
        };
      `;
      const blob = new Blob([workerSrc], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      const worker = new Worker(workerUrl);
      worker.onmessage = (ev) => {
        const processed = new Uint8ClampedArray(ev.data.buffer);
        ctx.putImageData(new ImageData(processed, width, height), 0, 0);
        resolve(canvas.toDataURL('image/png'));
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
      };
      worker.onerror = (err) => { reject(err); worker.terminate(); URL.revokeObjectURL(workerUrl); };
      worker.postMessage({ buffer: imageData.data.buffer, width, height }, [imageData.data.buffer]);
    };
    img.onerror = reject;
    img.src = imageUrl;
  });
}

// ---------------------------------------------------------------------------
// Memoized sub-components
// ---------------------------------------------------------------------------

type ElementCardProps = {
  el: ElementData;
  onEdit: (id: string) => void;
  onDragStart: (e: React.DragEvent, id: string) => void;
};

const ElementCard = React.memo(function ElementCard({ el, onEdit, onDragStart }: ElementCardProps) {
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, el.id)}
      className="aspect-square rounded-xl border border-gray-200 overflow-hidden cursor-grab active:cursor-grabbing hover:ring-2 hover:ring-blue-500 hover:ring-offset-1 transition-all bg-gray-50 flex items-center justify-center group relative"
    >
      <img src={el.src} alt="Element" className="max-w-full max-h-full object-contain p-2"
        style={{ filter: `brightness(${el.brightness}%) contrast(${el.contrast}%)` }} />
      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
        <button onClick={(e) => { e.stopPropagation(); onEdit(el.id); }}
          className="p-2 bg-white rounded-full text-gray-900 hover:bg-gray-100 shadow-sm" title="Adjust Filters">
          <Settings2 size={16} />
        </button>
      </div>
      {el.isRemovingBackground && (
        <div className="absolute inset-0 bg-white/50 flex items-center justify-center">
          <Loader2 className="animate-spin text-gray-900" size={24} />
        </div>
      )}
    </div>
  );
});

type CanvasElementItemProps = {
  el: CanvasElementData;
  isSelected: boolean;
  isDragging: boolean;
  onPointerDown: (e: React.PointerEvent, canvasId: string) => void;
};

const CanvasElementItem = React.memo(function CanvasElementItem({
  el, isSelected, isDragging, onPointerDown,
}: CanvasElementItemProps) {
  return (
    <div
      id={`canvas-el-${el.canvasId}`}
      onPointerDown={(e) => onPointerDown(e, el.canvasId)}
      style={{
        position: 'absolute', top: 0, left: 0,
        width: el.originalWidth || 150, height: el.originalHeight || 150,
        transform: `translate(${el.x}px, ${el.y}px) scale(${el.scale})`,
        transformOrigin: 'center', zIndex: isSelected ? 50 : 10,
        cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none',
      }}
      className={`flex items-center justify-center ${isSelected ? 'ring-2 ring-blue-500 ring-offset-2 rounded-lg bg-white/10 backdrop-blur-[2px]' : ''}`}
    >
      <img src={el.src} alt=""
        className={`max-w-full max-h-full object-contain pointer-events-none drop-shadow-lg ${el.isRemovingBackground ? 'opacity-50 blur-sm' : ''}`}
        style={{ filter: `brightness(${el.brightness}%) contrast(${el.contrast}%)` }} />
      {el.isRemovingBackground && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="animate-spin text-gray-900 drop-shadow-md" size={32} />
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Toast component
// ---------------------------------------------------------------------------

const ToastContainer = React.memo(function ToastContainer({
  toasts, onDismiss,
}: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed top-4 right-4 z-[200] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border text-sm font-medium max-w-xs animate-in slide-in-from-right-4 duration-200
            ${t.type === 'error'
              ? 'bg-red-50 border-red-200 text-red-700'
              : 'bg-blue-50 border-blue-200 text-blue-700'}`}
        >
          <span className="flex-1">{t.message}</span>
          <button onClick={() => onDismiss(t.id)} className="shrink-0 opacity-60 hover:opacity-100 transition-opacity">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

const TOAST_DURATION = 4000;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.15;

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
  const [snapGuides, setSnapGuides] = useState<{ type: 'vertical' | 'horizontal'; position: number }[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Sidebar open state — defaults to open; on small screens it becomes an overlay.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Canvas zoom level. CSS `zoom` property is used so layout reflows correctly
  // and getBoundingClientRect() returns zoomed screen coordinates throughout.
  const [canvasZoom, setCanvasZoom] = useState(1);

  // Refs for values used in event handlers (avoids stale-closure re-registrations).
  const bgImgRef = useRef<HTMLImageElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const elementsInputRef = useRef<HTMLInputElement>(null);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const canvasElementsRef = useRef<CanvasElementData[]>([]);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const canvasZoomRef = useRef(1);
  // Refs that mirror state so keyboard/wheel handlers don't need them as deps.
  const selectedElementIdRef = useRef<string | null>(null);
  const editingElementIdRef = useRef<string | null>(null);

  useEffect(() => { canvasElementsRef.current = canvasElements; }, [canvasElements]);
  useEffect(() => { canvasZoomRef.current = canvasZoom; }, [canvasZoom]);
  useEffect(() => { selectedElementIdRef.current = selectedElementId; }, [selectedElementId]);
  useEffect(() => { editingElementIdRef.current = editingElementId; }, [editingElementId]);

  // -------------------------------------------------------------------------
  // Toast helpers
  // -------------------------------------------------------------------------

  const addToast = useCallback((message: string, type: Toast['type'] = 'error') => {
    const id = crypto.randomUUID();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), TOAST_DURATION);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // -------------------------------------------------------------------------
  // API key check
  // -------------------------------------------------------------------------

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

  const handleSelectKey = useCallback(async () => {
    if (window.aistudio?.openSelectKey) {
      await window.aistudio.openSelectKey();
      setHasKey(true);
    }
  }, []);

  // -------------------------------------------------------------------------
  // File uploads
  // -------------------------------------------------------------------------

  const handleBackgroundUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { addToast('Background image must be smaller than 10MB.'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => setBackgroundImage(ev.target?.result as string);
    reader.readAsDataURL(file);
  }, [addToast]);

  const handleElementsUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setElements(prev => {
      const currentCount = prev.length;
      if (currentCount >= 10) { addToast('Maximum of 10 elements reached.'); return prev; }
      const availableSlots = 10 - currentCount;
      const filesToProcess = files.slice(0, availableSlots);
      if (files.length > availableSlots) {
        addToast(`Only ${availableSlots} more element(s) can be added. Some files were skipped.`, 'info');
      }
      filesToProcess.forEach(file => {
        if (file.size > 10 * 1024 * 1024) { addToast(`"${file.name}" is too large. Images must be under 10MB.`); return; }
        const reader = new FileReader();
        reader.onload = (ev) => {
          const src = ev.target?.result as string;
          const img = new Image();
          img.onload = () => {
            setElements(p => {
              if (p.length >= 10) return p;
              return [...p, { id: crypto.randomUUID(), src, brightness: 100, contrast: 100, originalWidth: img.naturalWidth, originalHeight: img.naturalHeight }];
            });
          };
          img.src = src;
        };
        reader.readAsDataURL(file);
      });
      return prev;
    });
  }, [addToast]);

  // -------------------------------------------------------------------------
  // Element management
  // -------------------------------------------------------------------------

  const updateElementFilter = useCallback((id: string, type: 'brightness' | 'contrast', value: number) => {
    setElements(prev => prev.map(el => el.id === id ? { ...el, [type]: value } : el));
    setCanvasElements(prev => prev.map(el => el.id === id ? { ...el, [type]: value } : el));
  }, []);

  const deleteElement = useCallback((id: string) => {
    setElements(prev => prev.filter(el => el.id !== id));
    setCanvasElements(prev => prev.filter(el => el.id !== id));
    setEditingElementId(prev => prev === id ? null : prev);
  }, []);

  const removeElementBackground = useCallback(async (id: string) => {
    const el = elements.find(e => e.id === id);
    if (!el) return;
    setElements(prev => prev.map(e => e.id === id ? { ...e, isRemovingBackground: true } : e));
    try {
      const { data: base64Data, mimeType } = parseDataUrl(el.src);
      const magentaImageUrl = await callGemini(base64Data, mimeType,
        'Extract the main subject of the image and place it on a pure, solid magenta background (Hex: #FF00FF). CRITICAL: DO NOT use a checkerboard or grid pattern. The background must be completely solid magenta.',
      );
      const processedImageUrl = await removeMagentaBackground(magentaImageUrl);
      setElements(prev => prev.map(e => e.id === id ? { ...e, src: processedImageUrl, isRemovingBackground: false } : e));
      setCanvasElements(prev => prev.map(e => e.id === id ? { ...e, src: processedImageUrl } : e));
    } catch (err) {
      console.error('Failed to remove background:', err);
      addToast('Failed to remove background. Please try again.');
      setElements(prev => prev.map(e => e.id === id ? { ...e, isRemovingBackground: false } : e));
    }
  }, [elements, addToast]);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const elementId = e.dataTransfer.getData('elementId');
    const element = elements.find(el => el.id === elementId);
    if (!element) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // Divide by zoom to convert screen px → CSS px (the coordinate space of el.x/y).
    const zoom = canvasZoomRef.current;
    const x = (e.clientX - rect.left) / zoom;
    const y = (e.clientY - rect.top) / zoom;
    const initialScale = element.originalWidth && element.originalHeight
      ? Math.min(150 / element.originalWidth, 150 / element.originalHeight, 1) : 1;
    const w = element.originalWidth || 150;
    const h = element.originalHeight || 150;
    const newEl: CanvasElementData = { ...element, canvasId: crypto.randomUUID(), scale: initialScale, x: x - w / 2, y: y - h / 2 };
    setCanvasElements(prev => [...prev, newEl]);
    setSelectedElementId(newEl.canvasId);
  }, [elements]);

  const bringToFront = useCallback((canvasId: string) => {
    setCanvasElements(prev => {
      const el = prev.find(e => e.canvasId === canvasId);
      if (!el) return prev;
      return [...prev.filter(e => e.canvasId !== canvasId), el];
    });
  }, []);

  const updateScale = useCallback((canvasId: string, scale: number) => {
    setCanvasElements(prev => prev.map(el => el.canvasId === canvasId ? { ...el, scale } : el));
  }, []);

  const removeCanvasElement = useCallback((canvasId: string) => {
    setCanvasElements(prev => prev.filter(el => el.canvasId !== canvasId));
    setSelectedElementId(prev => prev === canvasId ? null : prev);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent, canvasId: string) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedElementId(canvasId);
    bringToFront(canvasId);
    const elNode = document.getElementById(`canvas-el-${canvasId}`);
    if (!elNode) return;
    const rect = elNode.getBoundingClientRect();
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDraggingId(canvasId);
  }, [bringToFront]);

  // -------------------------------------------------------------------------
  // Drag effect — only re-registers listeners when drag starts/stops
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!draggingId) return;

    const handlePointerMove = (e: PointerEvent) => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (!bgImgRef.current) return;
        const bgRect = bgImgRef.current.getBoundingClientRect();
        const elNode = document.getElementById(`canvas-el-${draggingId}`);
        if (!elNode) return;

        const { x: offX, y: offY } = dragOffsetRef.current;
        let newScaledX = e.clientX - offX - bgRect.left;  // screen px
        let newScaledY = e.clientY - offY - bgRect.top;

        const elRect = elNode.getBoundingClientRect();
        const width = elRect.width;
        const height = elRect.height;
        const SNAP_THRESHOLD = 15;
        const guides: { type: 'vertical' | 'horizontal'; position: number }[] = [];

        if (Math.abs(newScaledX) < SNAP_THRESHOLD) { newScaledX = 0; guides.push({ type: 'vertical', position: 0 }); }
        else if (Math.abs(newScaledX + width - bgRect.width) < SNAP_THRESHOLD) { newScaledX = bgRect.width - width; guides.push({ type: 'vertical', position: bgRect.width }); }
        else if (Math.abs(newScaledX + width / 2 - bgRect.width / 2) < SNAP_THRESHOLD) { newScaledX = bgRect.width / 2 - width / 2; guides.push({ type: 'vertical', position: bgRect.width / 2 }); }

        if (Math.abs(newScaledY) < SNAP_THRESHOLD) { newScaledY = 0; guides.push({ type: 'horizontal', position: 0 }); }
        else if (Math.abs(newScaledY + height - bgRect.height) < SNAP_THRESHOLD) { newScaledY = bgRect.height - height; guides.push({ type: 'horizontal', position: bgRect.height }); }
        else if (Math.abs(newScaledY + height / 2 - bgRect.height / 2) < SNAP_THRESHOLD) { newScaledY = bgRect.height / 2 - height / 2; guides.push({ type: 'horizontal', position: bgRect.height / 2 }); }

        canvasElementsRef.current.forEach(otherEl => {
          if (otherEl.canvasId === draggingId) return;
          const otherNode = document.getElementById(`canvas-el-${otherEl.canvasId}`);
          if (!otherNode) return;
          const or = otherNode.getBoundingClientRect();
          const ox = or.left - bgRect.left, oy = or.top - bgRect.top, ow = or.width, oh = or.height;
          if (Math.abs(newScaledX - ox) < SNAP_THRESHOLD) { newScaledX = ox; guides.push({ type: 'vertical', position: ox }); }
          else if (Math.abs((newScaledX + width) - (ox + ow)) < SNAP_THRESHOLD) { newScaledX = ox + ow - width; guides.push({ type: 'vertical', position: ox + ow }); }
          else if (Math.abs((newScaledX + width / 2) - (ox + ow / 2)) < SNAP_THRESHOLD) { newScaledX = ox + ow / 2 - width / 2; guides.push({ type: 'vertical', position: ox + ow / 2 }); }
          else if (Math.abs(newScaledX - (ox + ow)) < SNAP_THRESHOLD) { newScaledX = ox + ow; guides.push({ type: 'vertical', position: ox + ow }); }
          else if (Math.abs((newScaledX + width) - ox) < SNAP_THRESHOLD) { newScaledX = ox - width; guides.push({ type: 'vertical', position: ox }); }
          if (Math.abs(newScaledY - oy) < SNAP_THRESHOLD) { newScaledY = oy; guides.push({ type: 'horizontal', position: oy }); }
          else if (Math.abs((newScaledY + height) - (oy + oh)) < SNAP_THRESHOLD) { newScaledY = oy + oh - height; guides.push({ type: 'horizontal', position: oy + oh }); }
          else if (Math.abs((newScaledY + height / 2) - (oy + oh / 2)) < SNAP_THRESHOLD) { newScaledY = oy + oh / 2 - height / 2; guides.push({ type: 'horizontal', position: oy + oh / 2 }); }
          else if (Math.abs(newScaledY - (oy + oh)) < SNAP_THRESHOLD) { newScaledY = oy + oh; guides.push({ type: 'horizontal', position: oy + oh }); }
          else if (Math.abs((newScaledY + height) - oy) < SNAP_THRESHOLD) { newScaledY = oy - height; guides.push({ type: 'horizontal', position: oy }); }
        });

        setSnapGuides(guides);

        const dragged = canvasElementsRef.current.find(e => e.canvasId === draggingId);
        const baseW = dragged?.originalWidth || 150;
        const baseH = dragged?.originalHeight || 150;
        // Convert screen px → CSS px (the coordinate space of el.x/y), accounting for zoom.
        const zoom = canvasZoomRef.current;
        const unscaledX = newScaledX / zoom - (baseW - width / zoom) / 2;
        const unscaledY = newScaledY / zoom - (baseH - height / zoom) / 2;

        setCanvasElements(prev => prev.map(el =>
          el.canvasId === draggingId ? { ...el, x: unscaledX, y: unscaledY } : el
        ));
      });
    };

    const handlePointerUp = () => {
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      setDraggingId(null);
      setSnapGuides([]);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    };
  }, [draggingId]);

  // -------------------------------------------------------------------------
  // Canvas zoom — Ctrl+scroll (non-passive to allow preventDefault)
  // -------------------------------------------------------------------------

  useEffect(() => {
    const viewport = canvasViewportRef.current;
    if (!viewport) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? (1 - ZOOM_STEP) : (1 + ZOOM_STEP);
      setCanvasZoom(prev => {
        const next = +(Math.min(Math.max(prev * factor, ZOOM_MIN), ZOOM_MAX).toFixed(2));
        canvasZoomRef.current = next;
        return next;
      });
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  // -------------------------------------------------------------------------
  // Keyboard shortcuts
  // Using refs for selectedElementId / editingElementId so this effect has
  // stable deps and doesn't re-register on every selection change.
  // -------------------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const selId = selectedElementIdRef.current;
      const editId = editingElementIdRef.current;

      if (e.key === 'Escape') {
        if (editId) setEditingElementId(null);
        else setSelectedElementId(null);
        return;
      }

      // Delete / Backspace — remove selected canvas element
      if ((e.key === 'Delete' || e.key === 'Backspace') && selId && !editId) {
        e.preventDefault();
        setCanvasElements(prev => prev.filter(el => el.canvasId !== selId));
        setSelectedElementId(null);
        return;
      }

      // [ / ] — scale selected element down / up by 5%
      if (selId && !editId) {
        if (e.key === '[') {
          e.preventDefault();
          const el = canvasElementsRef.current.find(el => el.canvasId === selId);
          if (el) setCanvasElements(prev => prev.map(c => c.canvasId === selId ? { ...c, scale: Math.max(0.1, +(c.scale - 0.05).toFixed(2)) } : c));
        } else if (e.key === ']') {
          e.preventDefault();
          setCanvasElements(prev => prev.map(c => c.canvasId === selId ? { ...c, scale: Math.min(2, +(c.scale + 0.05).toFixed(2)) } : c));
        }
      }

      // Ctrl/Cmd + 0 — reset zoom
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        setCanvasZoom(1);
        canvasZoomRef.current = 1;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []); // stable — reads all state via refs

  // -------------------------------------------------------------------------
  // Canvas background removal + composite generation
  // -------------------------------------------------------------------------

  const removeBackground = useCallback(async (canvasId: string) => {
    const el = canvasElementsRef.current.find(e => e.canvasId === canvasId);
    if (!el) return;
    setCanvasElements(prev => prev.map(e => e.canvasId === canvasId ? { ...e, isRemovingBackground: true } : e));
    try {
      const { data: base64Data, mimeType } = parseDataUrl(el.src);
      const newImageUrl = await callGemini(base64Data, mimeType,
        'Extract the main subject of the image and remove the background. Output the result as a PNG image with a TRUE transparent background (alpha channel = 0). CRITICAL: DO NOT output a checkerboard or grid pattern. The background must be completely clear and transparent.',
      );
      setCanvasElements(prev => prev.map(e => e.canvasId === canvasId ? { ...e, src: newImageUrl, isRemovingBackground: false } : e));
    } catch (err) {
      console.error('Failed to remove background:', err);
      addToast('Failed to remove background. Please try again.');
      setCanvasElements(prev => prev.map(e => e.canvasId === canvasId ? { ...e, isRemovingBackground: false } : e));
    }
  }, [addToast]);

  const generateComposite = useCallback(async () => {
    if (!bgImgRef.current) return;
    setIsGenerating(true);
    try {
      const bgRect = bgImgRef.current.getBoundingClientRect();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not get canvas context');
      const naturalWidth = bgImgRef.current.naturalWidth;
      const naturalHeight = bgImgRef.current.naturalHeight;
      canvas.width = naturalWidth;
      canvas.height = naturalHeight;
      const scaleX = naturalWidth / bgRect.width;
      const scaleY = naturalHeight / bgRect.height;
      ctx.drawImage(bgImgRef.current, 0, 0, naturalWidth, naturalHeight);
      for (const el of canvasElementsRef.current) {
        const elNode = document.getElementById(`canvas-el-${el.canvasId}`);
        const imgNode = elNode?.querySelector('img');
        if (!imgNode) continue;
        const elRect = imgNode.getBoundingClientRect();
        ctx.save();
        ctx.filter = `brightness(${el.brightness}%) contrast(${el.contrast}%)`;
        ctx.drawImage(imgNode, (elRect.left - bgRect.left) * scaleX, (elRect.top - bgRect.top) * scaleY, elRect.width * scaleX, elRect.height * scaleY);
        ctx.restore();
      }
      const { data: base64Data } = parseDataUrl(canvas.toDataURL('image/jpeg', 0.9));
      const newImageUrl = await callGemini(base64Data, 'image/jpeg',
        'This image contains a background and several elements overlaid on top of it. Please blend the overlaid elements naturally into the background. CRITICAL INSTRUCTIONS: 1. DO NOT change the original background image in any way (do not turn on lights, do not change the time of day, do not alter the room). 2. DO NOT change the appearance, color, or texture of the elements being added. 3. DO NOT project shadows or light patterns onto the elements (e.g., do not add window shadows across the sofa). 4. Only add subtle contact shadows underneath or behind the elements to ground them in the scene. 5. The final image must look exactly like the layout image, but with realistic contact shadows.',
      );
      setGeneratedImage(newImageUrl);
    } catch (err) {
      console.error('Generation failed:', err);
      addToast('Failed to generate image. Please try again.');
    } finally {
      setIsGenerating(false);
    }
  }, [addToast]);

  const downloadImage = useCallback(() => {
    if (!generatedImage) return;
    const a = document.createElement('a');
    a.href = generatedImage;
    a.download = 'blended-image.jpg';
    a.click();
  }, [generatedImage]);

  const handleEditElement = useCallback((id: string) => setEditingElementId(id), []);
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    e.dataTransfer.setData('elementId', id);
  }, []);

  const editingElement = useMemo(
    () => elements.find(e => e.id === editingElementId),
    [elements, editingElementId],
  );

  const selectedCanvasEl = useMemo(
    () => canvasElements.find(e => e.canvasId === selectedElementId),
    [canvasElements, selectedElementId],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

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
            <br /><br />
            <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-700 font-medium hover:underline">Learn more about billing</a>
          </p>
          <button onClick={handleSelectKey} className="bg-gray-900 text-white px-6 py-3.5 rounded-full font-semibold hover:bg-gray-800 transition-all w-full shadow-lg shadow-gray-900/20 active:scale-[0.98]">
            Select API Key
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#f5f5f5] font-sans text-gray-900 overflow-hidden">

      {/* ── Toasts ─────────────────────────────────────────────────────────── */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {/* ── Mobile sidebar backdrop ─────────────────────────────────────── */}
      {sidebarOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/30 z-20"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <div className={`
        fixed md:relative inset-y-0 left-0
        w-80 bg-white border-r border-gray-200 flex flex-col h-full shadow-sm z-30 shrink-0
        transition-transform duration-200
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        <div className="p-6 border-b border-gray-100 flex items-center justify-between">
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            ANYTHING <span className="font-light italic text-gray-500">anywhere</span>
            <span className="bg-gray-900 text-white text-[10px] font-black px-1.5 py-0.5 rounded uppercase tracking-widest ml-1">3D</span>
          </h1>
          {/* Close button — mobile only */}
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden text-gray-400 hover:text-gray-700 p-1"
            aria-label="Close sidebar"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {/* Background Section */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-bold tracking-widest text-gray-400 uppercase">Setting</h2>
            </div>
            <input type="file" accept="image/*" className="hidden" ref={fileInputRef} onChange={handleBackgroundUpload} />
            {backgroundImage ? (
              <div className="relative group rounded-xl overflow-hidden border border-gray-200 aspect-[4/3]">
                <img src={backgroundImage} alt="Setting" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <button onClick={() => fileInputRef.current?.click()} className="bg-white text-gray-900 px-4 py-2 rounded-full text-sm font-medium shadow-lg hover:bg-gray-50 transition-colors">
                    Change
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => fileInputRef.current?.click()} className="w-full aspect-[4/3] rounded-xl border-2 border-dashed border-gray-300 hover:border-gray-400 hover:bg-gray-50 transition-colors flex flex-col items-center justify-center text-gray-500 gap-2">
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
            <input type="file" accept="image/*" multiple className="hidden" ref={elementsInputRef} onChange={handleElementsUpload} />
            <div className="grid grid-cols-2 gap-3">
              {elements.map((el) => (
                <ElementCard key={el.id} el={el} onEdit={handleEditElement} onDragStart={handleDragStart} />
              ))}
              {elements.length < 10 && (
                <button onClick={() => elementsInputRef.current?.click()} className="aspect-square rounded-xl border-2 border-dashed border-gray-300 hover:border-gray-400 hover:bg-gray-50 transition-colors flex flex-col items-center justify-center text-gray-400 gap-1">
                  <Plus size={20} />
                  <span className="text-xs font-medium">Add</span>
                </button>
              )}
            </div>
            {elements.length > 0 && (
              <p className="text-xs text-gray-400 mt-3 text-center">Drag elements onto the canvas</p>
            )}
          </section>

          {/* Keyboard shortcuts hint */}
          <section className="pb-2">
            <h2 className="text-xs font-bold tracking-widest text-gray-400 uppercase mb-2">Shortcuts</h2>
            <dl className="text-xs text-gray-400 space-y-1">
              {[
                ['[ ]', 'Scale element'],
                ['Del', 'Remove element'],
                ['Esc', 'Deselect'],
                ['Ctrl+scroll', 'Zoom canvas'],
                ['Ctrl+0', 'Reset zoom'],
              ].map(([key, desc]) => (
                <div key={key} className="flex items-center gap-2">
                  <kbd className="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0">{key}</kbd>
                  <span>{desc}</span>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>

      {/* ── Main Area ───────────────────────────────────────────────────── */}
      <div className="flex-1 relative flex flex-col overflow-hidden min-w-0">

        {/* Mobile hamburger */}
        {!sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden absolute top-4 left-4 z-10 bg-white shadow-md border border-gray-200 p-2 rounded-xl text-gray-700 hover:bg-gray-50"
            aria-label="Open sidebar"
          >
            <Menu size={20} />
          </button>
        )}

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
              <button onClick={() => setGeneratedImage(null)} className="flex items-center gap-2 text-gray-600 hover:text-gray-900 font-medium transition-colors">
                <ArrowLeft size={20} /> Back to Edit
              </button>
              <div className="flex items-center gap-3">
                <button onClick={() => setIsFullscreen(true)} className="flex items-center gap-2 bg-white text-gray-900 border border-gray-200 px-4 py-2.5 rounded-full font-medium hover:bg-gray-50 transition-colors shadow-sm">
                  <Maximize2 size={18} /> View Full
                </button>
                <button onClick={downloadImage} className="flex items-center gap-2 bg-gray-900 text-white px-5 py-2.5 rounded-full font-medium hover:bg-gray-800 transition-colors shadow-md">
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
            {/* Canvas viewport — handles scroll (overflow) and Ctrl+wheel zoom */}
            <div ref={canvasViewportRef} className="flex-1 overflow-auto bg-gray-100 p-8">
              {/* The zoom is applied via CSS `zoom` (not transform) so that layout
                  reflows correctly and scroll is handled naturally by the parent. */}
              <div className="w-fit mx-auto relative shadow-2xl rounded-lg" style={{ zoom: canvasZoom }}>
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
                  {/* Snap guides */}
                  {snapGuides.map((guide, i) => (
                    <div
                      key={`guide-${i}`}
                      className="absolute bg-blue-500 z-40 pointer-events-none"
                      style={guide.type === 'vertical'
                        ? { left: guide.position, top: 0, bottom: 0, width: 1 }
                        : { top: guide.position, left: 0, right: 0, height: 1 }
                      }
                    />
                  ))}
                  {canvasElements.map(el => (
                    <CanvasElementItem
                      key={el.canvasId}
                      el={el}
                      isSelected={selectedElementId === el.canvasId}
                      isDragging={draggingId === el.canvasId}
                      onPointerDown={handlePointerDown}
                    />
                  ))}
                </div>
              </div>
            </div>

            {/* Zoom controls */}
            <div className="absolute bottom-8 left-8 z-40 flex items-center gap-1 bg-white/95 backdrop-blur-md rounded-full shadow-lg px-3 py-2 border border-gray-200">
              <button
                onClick={() => setCanvasZoom(prev => { const n = +(Math.max(prev - ZOOM_STEP, ZOOM_MIN).toFixed(2)); canvasZoomRef.current = n; return n; })}
                className="p-1 hover:bg-gray-100 rounded-full text-gray-700 transition-colors"
                aria-label="Zoom out"
              >
                <Minus size={14} />
              </button>
              <button
                onClick={() => { setCanvasZoom(1); canvasZoomRef.current = 1; }}
                className="text-xs font-medium text-gray-600 w-10 text-center hover:bg-gray-100 rounded-md py-0.5 transition-colors tabular-nums"
                title="Reset zoom (Ctrl+0)"
              >
                {Math.round(canvasZoom * 100)}%
              </button>
              <button
                onClick={() => setCanvasZoom(prev => { const n = +(Math.min(prev + ZOOM_STEP, ZOOM_MAX).toFixed(2)); canvasZoomRef.current = n; return n; })}
                className="p-1 hover:bg-gray-100 rounded-full text-gray-700 transition-colors"
                aria-label="Zoom in"
              >
                <Plus size={14} />
              </button>
            </div>

            {/* Floating toolbar for selected element */}
            {selectedElementId && selectedCanvasEl && (
              <div className="absolute bottom-24 left-1/2 -translate-x-1/2 bg-white/95 backdrop-blur-md rounded-full shadow-xl px-6 py-3 flex items-center gap-4 z-50 border border-gray-200">
                <span className="text-sm font-semibold text-gray-700 uppercase tracking-wider">Scale</span>
                <input
                  type="range" min="0.1" max="2" step="0.01"
                  value={selectedCanvasEl.scale}
                  onChange={(e) => updateScale(selectedElementId, parseFloat(e.target.value))}
                  className="w-24 accent-gray-900"
                />
                <span className="text-sm font-medium text-gray-600 w-12 text-right tabular-nums">
                  {Math.round(selectedCanvasEl.scale * 100)}%
                </span>
                <button
                  onClick={() => updateScale(selectedElementId, 1)}
                  className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-xs font-bold rounded-md transition-colors text-gray-700"
                >
                  100%
                </button>
                <div className="w-px h-6 bg-gray-200" />
                <button
                  onClick={() => removeBackground(selectedElementId)}
                  disabled={selectedCanvasEl.isRemovingBackground}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900 transition-colors disabled:opacity-50"
                >
                  <Eraser size={16} /> Remove BG
                </button>
                <div className="w-px h-6 bg-gray-200" />
                <button
                  onClick={() => removeCanvasElement(selectedElementId)}
                  className="text-red-500 hover:text-red-600 hover:bg-red-50 p-2 rounded-full transition-colors"
                  title="Remove element (Del)"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            )}

            {/* Generate button */}
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

      {/* ── Edit Element Modal ───────────────────────────────────────────── */}
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
                src={editingElement.src} alt="Preview"
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
                  <Eraser size={16} /> Remove BG
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
                <input type="range" min="0" max="200" value={editingElement.brightness}
                  onChange={(e) => updateElementFilter(editingElement.id, 'brightness', parseInt(e.target.value))}
                  className="w-full accent-gray-900" />
              </div>
              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm font-semibold text-gray-700">Contrast</label>
                  <span className="text-sm text-gray-500">{editingElement.contrast}%</span>
                </div>
                <input type="range" min="0" max="200" value={editingElement.contrast}
                  onChange={(e) => updateElementFilter(editingElement.id, 'contrast', parseInt(e.target.value))}
                  className="w-full accent-gray-900" />
              </div>
            </div>
            <div className="mt-6 shrink-0">
              <button onClick={() => setEditingElementId(null)} className="w-full bg-gray-900 text-white py-3 rounded-xl font-medium hover:bg-gray-800 transition-colors">
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Fullscreen Modal ─────────────────────────────────────────────── */}
      {isFullscreen && generatedImage && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <button onClick={() => setIsFullscreen(false)} className="absolute top-6 right-6 text-white/70 hover:text-white bg-black/50 p-3 rounded-full transition-colors">
            <Minimize2 size={24} />
          </button>
          <img src={generatedImage} alt="Generated Fullscreen" className="max-w-full max-h-full object-contain" />
        </div>
      )}
    </div>
  );
}
