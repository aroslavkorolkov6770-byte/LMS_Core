"use client";

import { useEffect } from "react";
import { connectPreviewDrafts } from "../lib/preview-draft-store";
import { connectPreviewControls, DEFAULT_PREVIEW_CONTROL, type PreviewControlState } from "../lib/preview-controls";

type DragSession = {
  elementId: string;
  element: HTMLElement;
  handle: HTMLElement;
  startClientX: number;
  startClientY: number;
  startOffsetX: number;
  startOffsetY: number;
  nextOffsetX: number;
  nextOffsetY: number;
  previousUserSelect: string;
};

const BRIDGE_SOURCE = "lms-preview-runtime";

function getElementOffset(control: PreviewControlState, elementId: string): { offsetX: number; offsetY: number } {
  const override = control.elementOverrides[elementId] ?? {};

  return {
    offsetX: Number.isFinite(override.offsetX) ? Number(override.offsetX) : 0,
    offsetY: Number.isFinite(override.offsetY) ? Number(override.offsetY) : 0
  };
}

function postPreviewMessage(message: Record<string, unknown>): void {
  window.parent.postMessage(
    {
      source: BRIDGE_SOURCE,
      clientId: new URLSearchParams(window.location.search).get("previewClientId"),
      ...message
    },
    window.location.origin
  );
}

export default function PreviewRuntimeBridge(): null {
  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);

    if (searchParams.get("previewEditable") !== "1" || window.parent === window) {
      return undefined;
    }

    const clientId = searchParams.get("previewClientId") ?? "local";
    if (searchParams.get("previewReadonly") === "1") {
      // Saved-site viewing shares the public design channel, not selection, drag, or localStorage controls.
      const ready = () => postPreviewMessage({ type: "frame-ready" });
      const disconnect = connectPreviewDrafts(window, clientId, ready);
      let secondFrame = 0;
      const firstFrame = window.requestAnimationFrame(() => { secondFrame = window.requestAnimationFrame(ready); });
      return () => { disconnect(); window.cancelAnimationFrame(firstFrame); window.cancelAnimationFrame(secondFrame); };
    }
    let editorConnected = false;
    const disconnectDrafts = connectPreviewDrafts(window, clientId, () => postPreviewMessage({ type: "frame-ready" }), () => {
      editorConnected = true;
      applyControlState();
    });
    let control: PreviewControlState = DEFAULT_PREVIEW_CONTROL;
    const disconnectControls = connectPreviewControls(window, clientId, (next) => { control = next; applyControlState(); });
    let dragSession: DragSession | null = null;
    let dragHandle: HTMLDivElement | null = null;
    let inlineEditor: HTMLTextAreaElement | null = null;

    const style = document.createElement("style");
    style.id = "lms-preview-runtime-bridge-style";
    document.head.appendChild(style);

    const clearDragHandle = () => {
      dragHandle?.remove();
      dragHandle = null;
    };

    const closeInlineEditor = () => {
      inlineEditor?.remove();
      inlineEditor = null;
    };

    const stopDrag = () => {
      if (!dragSession) {
        return;
      }

      const completedSession = dragSession;
      completedSession.element.classList.remove("lms-preview-dragging");
      completedSession.handle.classList.remove("lms-preview-dragging");
      completedSession.handle.style.transform = "";
      document.body.style.userSelect = completedSession.previousUserSelect;
      dragSession = null;

      postPreviewMessage({
        type: "move-element",
        elementId: completedSession.elementId,
        offsetX: completedSession.nextOffsetX,
        offsetY: completedSession.nextOffsetY
      });
    };

    const startDrag = (elementId: string, element: HTMLElement, handle: HTMLElement, event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const offset = getElementOffset(control, elementId);
      dragSession = {
        elementId,
        element,
        handle,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startOffsetX: offset.offsetX,
        startOffsetY: offset.offsetY,
        nextOffsetX: offset.offsetX,
        nextOffsetY: offset.offsetY,
        previousUserSelect: document.body.style.userSelect
      };

      element.classList.add("lms-preview-dragging");
      handle.classList.add("lms-preview-dragging");
      document.body.style.userSelect = "none";
    };

    const renderDragHandle = () => {
      if (dragSession) return;
      clearDragHandle();

      if (!editorConnected || !control.dragMode || !control.selectedId) {
        return;
      }

      const selectedElement = document.querySelector<HTMLElement>(
        `[data-preview-editable="${CSS.escape(control.selectedId)}"]`
      );

      if (!selectedElement) {
        return;
      }

      const rect = selectedElement.getBoundingClientRect();
      const handle = document.createElement("div");
      handle.id = "lms-preview-drag-handle";
      handle.textContent = "::";
      handle.setAttribute("role", "button");
      handle.setAttribute("aria-label", "Переместить выбранный блок");
      handle.style.left = `${Math.max(8, rect.right - 38)}px`;
      handle.style.top = `${Math.max(8, rect.top - 44)}px`;
      handle.addEventListener(
        "mousedown",
        (event) => startDrag(control.selectedId as string, selectedElement, handle, event),
        true
      );
      document.body.appendChild(handle);
      dragHandle = handle;
    };

    const commitInlineText = (elementId: string, nextText: string) => {
      const normalizedText = nextText.trim();

      if (!normalizedText) {
        closeInlineEditor();
        return;
      }

      closeInlineEditor();
      // React applies the new text from the parent draft; replacing its text nodes here breaks later edits.
      postPreviewMessage({
        type: "edit-text",
        elementId,
        nextText: normalizedText
      });
    };

    const openInlineTextEditor = (elementId: string, element: HTMLElement, event: MouseEvent) => {
      if (!control.textEditableIds.includes(elementId)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      closeInlineEditor();

      const rect = element.getBoundingClientRect();
      const editor = document.createElement("textarea");
      editor.id = "lms-preview-inline-text-editor";
      editor.value = element.innerText.trim();
      editor.setAttribute("aria-label", "Редактировать текст выбранного блока");
      editor.style.left = `${Math.max(8, rect.left)}px`;
      editor.style.top = `${Math.max(8, rect.top)}px`;
      editor.style.width = `${Math.min(Math.max(rect.width, 260), window.innerWidth - 24)}px`;
      editor.style.minHeight = `${Math.max(58, Math.min(rect.height + 22, 160))}px`;

      editor.addEventListener("keydown", (keyboardEvent) => {
        if (keyboardEvent.key === "Escape") {
          keyboardEvent.preventDefault();
          closeInlineEditor();
          return;
        }

        if (keyboardEvent.key === "Enter" && !keyboardEvent.shiftKey) {
          keyboardEvent.preventDefault();
          commitInlineText(elementId, editor.value);
        }
      });
      editor.addEventListener("mousedown", (mouseEvent) => mouseEvent.stopPropagation(), true);
      editor.addEventListener("click", (mouseEvent) => mouseEvent.stopPropagation(), true);

      document.body.appendChild(editor);
      inlineEditor = editor;
      editor.focus();
      editor.select();
    };

    const applyControlState = () => {
      document.body.dataset.previewSelectMode = editorConnected && control.selectMode ? "1" : "0";
      document.body.dataset.previewDragMode = editorConnected && control.dragMode ? "1" : "0";
      const textEditableSelectors = control.textEditableIds
        .map(
          (elementId) =>
            `body[data-preview-select-mode="1"] [data-preview-editable="${CSS.escape(elementId)}"]`
        )
        .join(",\n");
      const textEditableRule = textEditableSelectors
        ? `${textEditableSelectors} {
          text-decoration: underline dotted ${control.accent};
          text-underline-offset: 8px;
        }`
        : "";
      const selectedSelector = editorConnected && control.selectedId
        ? `[data-preview-editable="${CSS.escape(control.selectedId)}"]`
        : "";
      const selectedRule = selectedSelector
        ? `${selectedSelector} {
          outline: 3px solid ${control.primary} !important;
          outline-offset: 8px !important;
          box-shadow: 0 0 0 8px ${control.primary}22 !important;
        }

        body[data-preview-drag-mode="1"] ${selectedSelector} {
          cursor: grab !important;
        }`
        : "";

      style.textContent = `
        body[data-preview-select-mode="1"] [data-preview-editable] {
          outline: 2px dashed ${control.accent};
          outline-offset: 6px;
          cursor: crosshair !important;
        }

        ${textEditableRule}
        ${selectedRule}

        body[data-preview-drag-mode="1"] [data-preview-editable].lms-preview-dragging {
          cursor: grabbing !important;
          transition: none !important;
        }

        #lms-preview-drag-handle {
          position: fixed;
          z-index: 2147483647;
          width: 36px;
          height: 36px;
          border: 1px solid ${control.primary};
          border-radius: 12px;
          background: ${control.primary};
          color: ${control.buttonText};
          display: flex;
          align-items: center;
          justify-content: center;
          font: 900 12px/1 Arial, sans-serif;
          letter-spacing: -2px;
          box-shadow: 0 14px 30px ${control.primary}55;
          cursor: grab;
          user-select: none;
        }

        #lms-preview-drag-handle.lms-preview-dragging {
          cursor: grabbing;
        }

        #lms-preview-inline-text-editor {
          position: fixed;
          z-index: 2147483647;
          border: 1px solid ${control.primary};
          border-radius: 14px;
          background: rgba(8, 13, 18, 0.96);
          color: #ffffff;
          box-shadow: 0 18px 38px rgba(0, 0, 0, 0.42);
          outline: none;
          padding: 12px;
          resize: vertical;
          font: 800 15px/1.35 Arial, sans-serif;
        }
      `;

      renderDragHandle();
    };

    const clickHandler = (event: MouseEvent) => {
      if (!editorConnected || !control.selectMode) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const editableElement = target?.closest<HTMLElement>("[data-preview-editable]");

      if (!editableElement) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const elementId = editableElement.dataset.previewEditable;

      if (!elementId) {
        return;
      }

      control = {
        ...control,
        selectedId: elementId
      };
      applyControlState();
      postPreviewMessage({
        type: "select-element",
        elementId
      });
    };

    const doubleClickHandler = (event: MouseEvent) => {
      if (!editorConnected || !control.selectMode) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const editableElement = target?.closest<HTMLElement>("[data-preview-editable]");

      if (!editableElement) {
        return;
      }

      const elementId = editableElement.dataset.previewEditable;

      if (!elementId) {
        return;
      }

      openInlineTextEditor(elementId, editableElement, event);
    };

    const mouseMoveHandler = (event: MouseEvent) => {
      if (!dragSession) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const nextOffsetX = dragSession.startOffsetX + Math.round(event.clientX - dragSession.startClientX);
      const nextOffsetY = dragSession.startOffsetY + Math.round(event.clientY - dragSession.startClientY);

      dragSession.nextOffsetX = nextOffsetX;
      dragSession.nextOffsetY = nextOffsetY;
      dragSession.element.style.transform = `translate(${nextOffsetX}px, ${nextOffsetY}px)`;
      dragSession.handle.style.transform = `translate(${nextOffsetX - dragSession.startOffsetX}px, ${nextOffsetY - dragSession.startOffsetY}px)`;
    };

    const mouseUpHandler = (event: MouseEvent) => {
      if (!dragSession) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      stopDrag();
    };

    const resizeHandler = () => renderDragHandle();
    const scrollHandler = () => renderDragHandle();

    window.addEventListener("resize", resizeHandler);
    window.addEventListener("scroll", scrollHandler, true);
    document.addEventListener("click", clickHandler, true);
    document.addEventListener("dblclick", doubleClickHandler, true);
    document.addEventListener("mousemove", mouseMoveHandler, true);
    document.addEventListener("mouseup", mouseUpHandler, true);

    let firstInitializationFrameId = 0;
    let secondInitializationFrameId = 0;

    // React must finish hydrating the LMS before the editor adds service attributes.
    firstInitializationFrameId = window.requestAnimationFrame(() => {
      secondInitializationFrameId = window.requestAnimationFrame(() => {
        applyControlState();
        postPreviewMessage({ type: "frame-ready" });
      });
    });

    return () => {
      disconnectDrafts();
      disconnectControls();
      window.cancelAnimationFrame(firstInitializationFrameId);
      window.cancelAnimationFrame(secondInitializationFrameId);
      stopDrag();
      clearDragHandle();
      closeInlineEditor();
      style.remove();
      window.removeEventListener("resize", resizeHandler);
      window.removeEventListener("scroll", scrollHandler, true);
      document.removeEventListener("click", clickHandler, true);
      document.removeEventListener("dblclick", doubleClickHandler, true);
      document.removeEventListener("mousemove", mouseMoveHandler, true);
      document.removeEventListener("mouseup", mouseUpHandler, true);
      delete document.body.dataset.previewSelectMode;
      delete document.body.dataset.previewDragMode;
      document.querySelectorAll<HTMLElement>("[data-preview-editable]").forEach((element) => {
        element.classList.remove("lms-preview-dragging");
      });
    };
  }, []);

  return null;
}
