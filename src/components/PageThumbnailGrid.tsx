import React, { useState, useEffect, useRef } from 'react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Page } from 'react-pdf';
import { RotateCw, RotateCcw, Trash2, Check, RotateCcwSquare } from 'lucide-react';

interface SortableThumbnailProps {
  id: string;
  originalIndex: number;
  displayIndex: number;
  rotation: number;
  isSelected: boolean;
  isDeleted: boolean;
  onToggleSelect: (originalIndex: number) => void;
  onToggleDelete: (originalIndex: number) => void;
  onRotate: (originalIndex: number, direction: 'cw' | 'ccw') => void;
}

const SortableThumbnail: React.FC<SortableThumbnailProps> = ({
  id,
  originalIndex,
  displayIndex,
  rotation,
  isSelected,
  isDeleted,
  onToggleSelect,
  onToggleDelete,
  onRotate,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : 1,
    opacity: isDragging ? 0.8 : 1,
  };

  const [isInView, setIsInView] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setIsInView(true);
        }
      },
      { rootMargin: '200px' }
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative flex flex-col items-center group transition-all duration-200 ${isDeleted ? 'opacity-40 grayscale' : ''}`}
    >
      <div
        ref={containerRef}
        className={`relative shadow-md bg-white transition-transform duration-300 flex items-center justify-center overflow-hidden rounded-md border-2 ${isSelected ? 'border-[#005db2] shadow-lg' : 'border-transparent hover:border-black/10'}`}
      >
        <div
          className="transition-transform duration-300"
          style={{ transform: `rotate(${rotation || 0}deg)` }}
        >
          {isInView ? (
            <Page
              pageNumber={originalIndex + 1}
              width={160}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              className="pointer-events-none select-none"
            />
          ) : (
            <div style={{ width: 160, height: 226 }} className="bg-gray-100 flex items-center justify-center">
              <span className="text-gray-400 text-xs">Loading...</span>
            </div>
          )}
        </div>

        {/* Drag Handle Overlay */}
        <div
          {...attributes}
          {...listeners}
          className="absolute inset-0 cursor-grab active:cursor-grabbing z-10 hover:bg-black/5"
        />

        {/* Selection checkmark */}
        {isSelected && (
          <div className="absolute top-2 left-2 w-6 h-6 bg-[#005db2] rounded-full text-white flex items-center justify-center shadow-md z-20">
            <Check className="w-3.5 h-3.5" />
          </div>
        )}

        {/* Hover Controls */}
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col justify-between p-2 pointer-events-none z-20">
          <div className="flex justify-between w-full">
            <button
              onPointerDown={(e) => {
                e.stopPropagation();
                onToggleDelete(originalIndex);
              }}
              className={`p-1.5 rounded-md pointer-events-auto shadow-sm transition-colors ${isDeleted ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-white/80 text-red-500 hover:bg-red-50'}`}
              title={isDeleted ? 'Restore page' : 'Delete page'}
            >
              {isDeleted ? <RotateCcwSquare className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
            </button>

            <button
              onPointerDown={(e) => {
                e.stopPropagation();
                onToggleSelect(originalIndex);
              }}
              className={`p-1.5 rounded-md pointer-events-auto shadow-sm transition-colors ${isSelected ? 'bg-[#005db2] text-white hover:bg-[#004a8f]' : 'bg-white/80 text-[#005db2] hover:bg-blue-50'}`}
              title={isSelected ? 'Deselect page' : 'Select page'}
            >
              <Check className="w-4 h-4" />
            </button>
          </div>

          <div className="flex justify-center space-x-2 pb-2">
            <button
              onPointerDown={(e) => {
                e.stopPropagation();
                onRotate(originalIndex, 'ccw');
              }}
              className="p-1.5 bg-black/60 hover:bg-black/80 text-white rounded-md pointer-events-auto shadow-sm backdrop-blur-sm transition-colors"
              title="Rotate Left"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              onPointerDown={(e) => {
                e.stopPropagation();
                onRotate(originalIndex, 'cw');
              }}
              className="p-1.5 bg-black/60 hover:bg-black/80 text-white rounded-md pointer-events-auto shadow-sm backdrop-blur-sm transition-colors"
              title="Rotate Right"
            >
              <RotateCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <span className="mt-2 text-[11px] font-mono font-medium text-[#625e5a] bg-white/80 px-2 py-0.5 rounded-md border border-black/5 shadow-2xs">
        {displayIndex + 1}
      </span>
      {originalIndex !== displayIndex && (
        <span className="mt-0.5 text-[9px] text-[#625e5a]/60">
          (was {originalIndex + 1})
        </span>
      )}
    </div>
  );
};

interface PageThumbnailGridProps {
  pageOrder: number[];
  selectedPages: number[];
  deletedPages: number[];
  rotations: Record<number, number>;
  onReorder: (newOrder: number[], movedOriginalIndex: number) => void;
  onToggleSelect: (originalIndex: number) => void;
  onToggleDelete: (originalIndex: number) => void;
  onRotate: (originalIndex: number, direction: 'cw' | 'ccw') => void;
}

export const PageThumbnailGrid: React.FC<PageThumbnailGridProps> = ({
  pageOrder,
  selectedPages,
  deletedPages,
  rotations,
  onReorder,
  onToggleSelect,
  onToggleDelete,
  onRotate,
}) => {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = pageOrder.indexOf(Number(active.id));
      const newIndex = pageOrder.indexOf(Number(over.id));
      onReorder(arrayMove(pageOrder, oldIndex, newIndex), Number(active.id));
    }
  };

  const stringIds = pageOrder.map(String);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={stringIds} strategy={rectSortingStrategy}>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 justify-items-center">
          {pageOrder.map((originalIndex, displayIndex) => (
            <SortableThumbnail
              key={originalIndex}
              id={String(originalIndex)}
              originalIndex={originalIndex}
              displayIndex={displayIndex}
              rotation={rotations[originalIndex] || 0}
              isSelected={selectedPages.includes(originalIndex)}
              isDeleted={deletedPages.includes(originalIndex)}
              onToggleSelect={onToggleSelect}
              onToggleDelete={onToggleDelete}
              onRotate={onRotate}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
};
