const RESIZE_HANDLES = [
	{ dir: "n", style: "top-0 left-4 right-4 h-1 cursor-n-resize" },
	{ dir: "s", style: "bottom-0 left-4 right-4 h-1 cursor-s-resize" },
	{ dir: "e", style: "right-0 top-4 bottom-4 w-1 cursor-e-resize" },
	{ dir: "w", style: "left-0 top-4 bottom-4 w-1 cursor-w-resize" },
	{ dir: "ne", style: "top-0 right-0 w-4 h-4 cursor-ne-resize" },
	{ dir: "nw", style: "top-0 left-0 w-4 h-4 cursor-nw-resize" },
	{ dir: "se", style: "bottom-0 right-0 w-4 h-4 cursor-se-resize" },
	{ dir: "sw", style: "bottom-0 left-0 w-4 h-4 cursor-sw-resize" },
] as const;

interface ResizeHandlesProps {
	onResize: (e: React.MouseEvent, dir: string) => void;
}

export function ResizeHandles({ onResize }: ResizeHandlesProps) {
	return (
		<>
			{RESIZE_HANDLES.map((h) => (
				<button
					key={h.dir}
					className={`absolute ${h.style} opacity-0 hover:opacity-100 bg-blue-400/30 rounded transition-opacity border-none p-0 outline-none`}
					onMouseDown={(e) => onResize(e, h.dir)}
					type="button"
					tabIndex={-1}
					aria-label="Oyna o'lchamini o'zgartirish"
				/>
			))}
		</>
	);
}
