import {
  getClientPreviewElementOverride,
  type ClientPreviewSettings
} from "@lms-core/shared";
import type { CSSProperties } from "react";

export function getPreviewElementStyle(
  settings: ClientPreviewSettings,
  elementId: string,
  baseStyle: CSSProperties = {}
): CSSProperties {
  const override = getClientPreviewElementOverride(settings, elementId);

  if (!override.visible) {
    return {
      ...baseStyle,
      display: "none"
    };
  }

  const overrideStyle: CSSProperties = {};

  if (override.widthPercent !== 100) {
    overrideStyle.width = `${override.widthPercent}%`;
  }

  if (override.align === "left") {
    overrideStyle.marginLeft = 0;
    overrideStyle.marginRight = "auto";
    overrideStyle.textAlign = "left";
  }

  if (override.align === "right") {
    overrideStyle.marginLeft = "auto";
    overrideStyle.marginRight = 0;
    overrideStyle.textAlign = "right";
  }

  if (override.align === "center" && override.widthPercent !== 100) {
    overrideStyle.marginLeft = "auto";
    overrideStyle.marginRight = "auto";
    overrideStyle.textAlign = "center";
  }

  if (override.marginTopPx !== 0) {
    overrideStyle.marginTop = override.marginTopPx;
  }

  if (override.marginBottomPx !== 0) {
    overrideStyle.marginBottom = override.marginBottomPx;
  }

  if (override.offsetX !== 0 || override.offsetY !== 0) {
    overrideStyle.transform = `translate(${override.offsetX}px, ${override.offsetY}px)`;
  }

  if (override.paddingPx > 0) {
    overrideStyle.padding = override.paddingPx;
  }

  if (override.backgroundColor) {
    overrideStyle.backgroundColor = override.backgroundColor;
  }

  if (override.textColor) {
    overrideStyle.color = override.textColor;
  }

  if (override.borderColor) {
    overrideStyle.borderColor = override.borderColor;
    overrideStyle.borderStyle = "solid";
    overrideStyle.borderWidth = 1;
  }

  return {
    ...baseStyle,
    ...overrideStyle
  };
}
