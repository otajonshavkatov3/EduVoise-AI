import { useCallback, useEffect, useRef, useState } from "react";

interface Position {
	x: number;
	y: number;
}

interface Size {
	width: number;
	height: number;
}

const MIN_WIDTH = 340;
const MIN_HEIGHT = 400;

/**
 * Drag va resize logikasini boshqaruvchi hook.
 * CallPopModal uchun floating window harakatlanishi va o'lchamini o'zgartirish.
 */
export function useFloatingWindow() {
	const [position, setPosition] = useState<Position>({ x: window.innerWidth - 380, y: 32 });
	const [size, setSize] = useState<Size>({ width: 360, height: 700 });
	const [isDragging, setIsDragging] = useState(false);
	const [resizeDir, setResizeDir] = useState<string | null>(null);

	const dragStartPos = useRef({ x: 0, y: 0 });
	const resizeStartData = useRef({ w: 0, h: 0, x: 0, y: 0, mouseX: 0, mouseY: 0 });
	const modalRef = useRef<HTMLDivElement>(null);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			if ((e.target as HTMLElement).closest(".ant-card-head")) {
				setIsDragging(true);
				dragStartPos.current = {
					x: e.clientX - position.x,
					y: e.clientY - position.y,
				};
			}
		},
		[position]
	);

	const handleResizeMouseDown = useCallback(
		(e: React.MouseEvent, dir: string) => {
			e.stopPropagation();
			e.preventDefault();
			setResizeDir(dir);
			resizeStartData.current = {
				w: size.width,
				h: size.height,
				x: position.x,
				y: position.y,
				mouseX: e.clientX,
				mouseY: e.clientY,
			};
		},
		[size, position]
	);

	useEffect(() => {
		if (!(isDragging || resizeDir)) {
			return;
		}

		const handleMouseMove = (e: MouseEvent) => {
			if (isDragging) {
				setPosition({
					x: e.clientX - dragStartPos.current.x,
					y: e.clientY - dragStartPos.current.y,
				});
				return;
			}

			if (!resizeDir) {
				return;
			}

			const dx = e.clientX - resizeStartData.current.mouseX;
			const dy = e.clientY - resizeStartData.current.mouseY;
			const { w, h, x, y } = resizeStartData.current;

			let newWidth = w;
			let newHeight = h;
			let newX = x;
			let newY = y;

			if (resizeDir.includes("e")) {
				newWidth = Math.max(MIN_WIDTH, w + dx);
			} else if (resizeDir.includes("w")) {
				const possibleWidth = Math.max(MIN_WIDTH, w - dx);
				newX = x + (w - possibleWidth);
				newWidth = possibleWidth;
			}

			if (resizeDir.includes("s")) {
				newHeight = Math.max(MIN_HEIGHT, h + dy);
			} else if (resizeDir.includes("n")) {
				const possibleHeight = Math.max(MIN_HEIGHT, h - dy);
				newY = y + (h - possibleHeight);
				newHeight = possibleHeight;
			}

			setSize({ width: newWidth, height: newHeight });
			setPosition({ x: newX, y: newY });
		};

		const handleMouseUp = () => {
			setIsDragging(false);
			setResizeDir(null);
		};

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);
		document.body.style.userSelect = "none";

		return () => {
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
			document.body.style.userSelect = "";
		};
	}, [isDragging, resizeDir]);

	return {
		position,
		size,
		isDragging,
		modalRef,
		handleMouseDown,
		handleResizeMouseDown,
	};
}
