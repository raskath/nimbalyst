import React, { useId, useRef, useState } from 'react';
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import { PROJECT_RAIL_GROUP_COLORS } from '../store/atoms/projectRailGroups';

interface ProjectRailGroupEditorProps {
  /** The rail element the editor sits beside. */
  anchor: Element;
  title: string;
  submitLabel: string;
  initialName: string;
  initialColor?: string;
  onSubmit: (value: { name: string; color: string | null }) => void;
  onCancel: () => void;
}

/** Name and folder color of a rail group. Escape or a click outside cancels. */
export function ProjectRailGroupEditor({
  anchor,
  title,
  submitLabel,
  initialName,
  initialColor,
  onSubmit,
  onCancel,
}: ProjectRailGroupEditorProps) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState<string | null>(initialColor ?? null);
  const nameId = useId();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (open) => { if (!open) onCancel(); },
    elements: { reference: anchor },
    placement: 'right-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(12), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
  });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'dialog' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  return (
    <FloatingPortal>
      <FloatingFocusManager context={context} initialFocus={nameRef}>
        <form
          ref={refs.setFloating}
          className="project-rail-group-editor"
          style={floatingStyles}
          aria-label={title}
          data-testid="project-rail-group-editor"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({ name, color });
          }}
          {...getFloatingProps()}
        >
          <div className="project-rail-group-editor-title">{title}</div>
          <label className="project-rail-group-editor-label" htmlFor={nameId}>Name</label>
          <input
            id={nameId}
            ref={nameRef}
            className="project-rail-group-editor-name nim-input"
            value={name}
            maxLength={60}
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="project-rail-group-editor-label">Color</div>
          <div className="project-rail-group-editor-colors">
            <button
              type="button"
              className="project-rail-group-editor-swatch is-none"
              aria-label="No color"
              aria-pressed={color === null}
              onClick={() => setColor(null)}
            />
            {PROJECT_RAIL_GROUP_COLORS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="project-rail-group-editor-swatch"
                style={{ '--swatch-color': option.value } as React.CSSProperties}
                aria-label={option.name}
                aria-pressed={color === option.value}
                onClick={() => setColor(option.value)}
              />
            ))}
          </div>
          <div className="project-rail-group-editor-actions">
            <button type="button" className="nim-btn-secondary" onClick={onCancel}>Cancel</button>
            <button type="submit" className="nim-btn-primary">{submitLabel}</button>
          </div>
        </form>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}
