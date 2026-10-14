import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";

type Props = React.TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number };

/** A textarea that grows with its content instead of scrolling. */
const AutoTextarea = forwardRef<HTMLTextAreaElement, Props>(function AutoTextarea(
  { minRows = 1, className = "", value, ...rest },
  ref
) {
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current!);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);

  return <textarea ref={inner} rows={minRows} value={value} className={`field resize-none ${className}`} {...rest} />;
});

export default AutoTextarea;
