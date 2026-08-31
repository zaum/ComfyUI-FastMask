import hashlib
import io
import os

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths


class FastMaskEditor:
    """All-in-one image loader + mask editor, like the built-in LoadImage.

    Loads an image from the ComfyUI input directory (dropdown + upload button,
    same widgets/mechanism as LoadImage), outputs both the IMAGE and a MASK.
    Open the FastMask editor from the node button / right-click menu to paint
    the mask (full resolution on export, fast preview-res painting)."""

    @classmethod
    def INPUT_TYPES(s):
        input_dir = folder_paths.get_input_directory()
        files = [
            f
            for f in os.listdir(input_dir)
            if os.path.isfile(os.path.join(input_dir, f))
        ]
        return {
            "required": {
                # image_upload: True -> the built-in frontend extension adds
                # the upload/refresh buttons and the preview to the node
                # (same mechanism as LoadImage)
                "image": (sorted(files), {"image_upload": True}),
                "mask_path": ("STRING", {"default": ""}),
            },
            # optional IMAGE input: when another node (e.g. LoadImage) output
            # is connected here, it overrides the dropdown-selected image
            "optional": {
                "image_opt": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    OUTPUT_NODE = True
    FUNCTION = "load"
    CATEGORY = "mask"
    DESCRIPTION = (
        "Image loader + mask editor in one node. Select/upload an image, "
        "open the FastMask editor (button or right-click menu) to paint a "
        "mask. Outputs IMAGE and MASK (1.0 = masked area)."
    )

    @classmethod
    def VALIDATE_INPUTS(s, image, **kwargs):
        # The image combo list is computed at node-definition time, but new
        # files can appear later (Ctrl+V paste -> input/paste/xxx.png, direct
        # upload). The default "value must be in list" validation would reject
        # those, so validate by file existence instead - same as LoadImage.
        if not folder_paths.exists_annotated_filepath(image):
            return f"Invalid image file: {image}"
        return True

    def load(self, image, mask_path="", image_opt=None):
        import time, traceback
        try:
            if image_opt is not None:
                return self._load_from_tensor(image_opt, mask_path)

            img_path = folder_paths.get_annotated_filepath(image)
            img = Image.open(img_path)
            img = ImageOps.exif_transpose(img)
            if img.mode == "I":
                img = img.point(lambda i: i * (1 / 255)).convert("L")

            out_image = img.convert("RGB")
            w, h = out_image.size
            out_image = np.array(out_image).astype(np.float32) / 255.0
            out_image = torch.from_numpy(out_image)[None,]

            mask, ui_images = self._load_mask_and_preview(img, (w, h), mask_path, img_path, image)
            return self._finalize(out_image, mask, ui_images)
        except Exception as e:
            print(f"[FastMask] load() failed: {e}")
            traceback.print_exc()
            # Always return a valid preview so the node doesn't show "failed to load".
            preview_dir = os.path.join(folder_paths.get_input_directory(), "fastmask")
            os.makedirs(preview_dir, exist_ok=True)
            save_name = f"fastmask_error_{int(time.time() * 1000) % 1000000}.png"
            w, h = 256, 256
            if image_opt is not None:
                t = image_opt[0].detach().clamp(0, 1).cpu().numpy()
                h, w = t.shape[0], t.shape[1]
            err_img = Image.new("RGB", (w, h), (64, 0, 0))
            try:
                err_img.save(os.path.join(preview_dir, save_name), format="PNG", compress_level=1)
            except Exception:
                save_name = None
            ui_images = [{"filename": save_name, "subfolder": "fastmask", "type": "input"}] if save_name else []
            if image_opt is not None:
                out_image = torch.from_numpy(image_opt[0].detach().cpu().numpy().astype(np.float32))[None,]
            else:
                out_image = torch.zeros((1, h, w, 3), dtype=torch.float32)
            out_mask = torch.zeros((1, h, w), dtype=torch.float32)
            return {"ui": {"images": ui_images}, "result": (out_image, out_mask)}

    def _load_from_tensor(self, image_opt, mask_path=""):
        """Works from a connected IMAGE tensor (B,H,W,C, 0..1 float)."""
        t = image_opt[0].detach().clamp(0, 1).cpu().numpy()
        h, w = t.shape[0], t.shape[1]
        out_image = torch.from_numpy(t.astype(np.float32))[None,]

        pil = Image.fromarray((t * 255.0).round().astype(np.uint8), "RGB")
        mask, ui_images = self._load_mask_and_preview(pil, (w, h), mask_path, None, None)
        return self._finalize(out_image, mask, ui_images)

    def _source_ui(self, image_value):
        """Build the ui.images reference for the ORIGINAL source image so the
        node always shows the real image (never a fragile generated preview)."""
        if not image_value:
            return None
        parts = str(image_value).split("/")
        fname = parts[-1]
        sub = "/".join(parts[:-1])
        return [{"filename": fname, "subfolder": sub, "type": "input"}]

    def _load_mask_and_preview(self, img, size, mask_path, img_path, image_value=None):
        """Load the mask (mask_path) and decide what to show on the node.

        For a file-based image we simply show the ORIGINAL source image on the
        node (reliable, never disappears). When the image comes from a connected
        tensor (no source file) we generate a preview PNG instead.
        """
        w, h = size
        mask = None
        if mask_path:
            mpath = folder_paths.get_annotated_filepath(mask_path)
            if os.path.isfile(mpath):
                m = Image.open(mpath).convert("RGBA")
                if m.size != (w, h):
                    m = m.resize((w, h), Image.BILINEAR)
                mask = np.asarray(m)[:, :, 3].astype(np.float32) / 255.0
            else:
                print(f"[FastMask] mask file not found: {mpath}")
        if mask is None:
            # No painted mask yet -> empty mask (nothing is masked).
            out_mask = torch.zeros((h, w), dtype=torch.float32)
        else:
            out_mask = torch.from_numpy(mask).to(torch.float32)
        out_mask = out_mask.unsqueeze(0)

        # File-based image: show the original on the node (always available).
        if image_value:
            ui_images = self._source_ui(image_value)
            print(f"[FastMask] mask: path={mask_path!r} painted={(float((out_mask[0] > 0.5).float().mean()) * 100):.1f}% size={w}x{h}")
            return out_mask, ui_images or []

        # Tensor-based image (no source file): generate a preview PNG so the
        # node has something to display.
        preview = img.convert("RGB")
        if mask is not None:
            overlay = Image.new("RGB", preview.size, (255, 0, 200))
            m8 = Image.fromarray((np.clip(mask, 0.0, 1.0) * 255.0).astype(np.uint8), "L")
            if m8.size != preview.size:
                m8 = m8.resize(preview.size, Image.BILINEAR)
            preview = Image.composite(overlay, preview, m8.point(lambda v: int(v * 0.55)))
        save_name = None
        try:
            painted = float((out_mask[0] > 0.5).float().mean())
            print(f"[FastMask] mask: path={mask_path!r} painted={painted * 100:.1f}% size={w}x{h}")
            preview_dir = os.path.join(folder_paths.get_input_directory(), "fastmask")
            os.makedirs(preview_dir, exist_ok=True)
            buf = io.BytesIO()
            preview.save(buf, format="PNG", compress_level=1)
            m = hashlib.sha256(buf.getvalue())
            if mask_path:
                mpath = folder_paths.get_annotated_filepath(mask_path)
                if os.path.isfile(mpath):
                    m.update(str(os.path.getmtime(mpath)).encode())
            save_name = "fastmask_preview_%s.png" % m.hexdigest()[:16]
            preview.save(os.path.join(preview_dir, save_name), format="PNG", compress_level=1)
        except Exception as e:
            print(f"[FastMask] preview save failed: {e}")
            save_name = None
        return out_mask, ([{"filename": save_name, "subfolder": "fastmask", "type": "input"}] if save_name else [])

    def _finalize(self, out_image, out_mask, ui_images):
        return {"ui": {"images": ui_images or []}, "result": (out_image, out_mask)}

    @classmethod
    def IS_CHANGED(s, image, mask_path=""):
        img_path = folder_paths.get_annotated_filepath(image)
        m = hashlib.sha256()
        with open(img_path, "rb") as f:
            m.update(f.read())
        h = m.digest().hex()
        if mask_path:
            mpath = folder_paths.get_annotated_filepath(mask_path)
            if os.path.isfile(mpath):
                # a painted-mask change also re-runs the node
                h += ":" + str(os.path.getmtime(mpath))
        return h


NODE_CLASS_MAPPINGS = {
    "FastMaskEditor": FastMaskEditor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "FastMaskEditor": "FastMask Editor",
}
