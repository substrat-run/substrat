import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { AssistantLabels, AssistantModel, SubAssistant } from '@substrat-run/elements';

export interface AssistantProps {
  /** The conversation. Keep it above whatever opens and closes; a new one starts over. */
  model: AssistantModel;
  labels?: Partial<AssistantLabels> | undefined;
  /** The transcript's accessible name. */
  label?: string;
  placeholder?: string;
  maxLength?: number;
  headingLevel?: number;
  /** For a host with its own input, which calls `model.send(text)`. */
  hideComposer?: boolean;
  /** What shows before the first question. */
  empty?: ReactNode;
  style?: CSSProperties;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'sub-assistant': React.DetailedHTMLProps<React.HTMLAttributes<SubAssistant>, SubAssistant> & {
        label?: string | undefined;
        placeholder?: string | undefined;
        'max-length'?: number | undefined;
        'heading-level'?: number | undefined;
        'hide-composer'?: boolean | undefined;
      };
    }
  }
}

/** `<sub-assistant>` under React 18, which sets an unknown property as an attribute and so cannot hand it the model. */
export function Assistant({ model, labels, label, placeholder, maxLength, headingLevel, hideComposer, empty, style }: AssistantProps) {
  const element = useRef<SubAssistant>(null);
  useEffect(() => {
    if (!element.current) return;
    element.current.model = model;
    element.current.labels = labels;
  }, [model, labels]);
  return (
    <sub-assistant
      ref={element}
      label={label}
      placeholder={placeholder}
      max-length={maxLength}
      heading-level={headingLevel}
      hide-composer={hideComposer || undefined}
      style={style}
    >
      {empty !== undefined && <div slot="empty">{empty}</div>}
    </sub-assistant>
  );
}
