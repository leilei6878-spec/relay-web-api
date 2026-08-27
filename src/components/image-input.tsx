import { useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function ImageInput({
  images,
  onChange,
  hint = "可上传最多 4 张，作为对话理解或出图参考",
  max = 4,
}: {
  images: string[];
  onChange: (next: string[]) => void;
  hint?: string;
  max?: number;
}) {
  const ref = useRef<HTMLInputElement>(null);

  async function add(files: FileList | null) {
    if (!files?.length) return;
    const next = [...images];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      if (next.length >= max) break;
      if (file.size > 4_000_000) {
        toast.error(`${file.name || "图片"} 超过 4MB，未加入参考图`);
        continue;
      }
      next.push(await readDataUrl(file));
    }
    onChange(next);
    if (ref.current) ref.current.value = "";
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => ref.current?.click()}>
          添加图片
        </Button>
        <span className="text-xs text-subtle">{hint}</span>
        <input
          ref={ref}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          onChange={(e) => void add(e.target.files)}
        />
      </div>
      {images.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {images.map((src, i) => (
            <li key={`${i}-${src.slice(0, 24)}`} className="relative">
              <img src={src} alt="" className="h-16 w-16 rounded-md object-cover" />
              <button
                type="button"
                className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-elevated text-[10px] text-muted"
                onClick={() => onChange(images.filter((_, j) => j !== i))}
                aria-label="移除图片"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读图失败"));
    reader.readAsDataURL(file);
  });
}
