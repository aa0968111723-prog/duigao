import { useRef, useState, type ReactNode } from "react";

type Props = {
  onFiles: (files: FileList | null) => void;
  className?: string;
  children: ReactNode;
  /** Defaults to posters; video review passes its own list of playable types. */
  accept?: string;
  /** Video rooms take one cut at a time, so the caller can turn this off. */
  multiple?: boolean;
};

/** File picker shared by the home screen, the version row and the more sheet. */
export function UploadZone({
  onFiles,
  className = "",
  children,
  accept = "image/*",
  multiple = true,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  return (
    <div
      className={`${className} ${drag ? "upload-drag" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        onFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {children}
    </div>
  );
}
