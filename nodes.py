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

    def load(self, image, mask_path="", image_opt=None):
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

        mask, save_name = self._load_mask_and_preview(img, (w, h), mask_path, img_path)
        return self._finalize(out_image, mask, save_name)

    def _load_from_tensor(self, image_opt, mask_path=""):
        """Works from a connected IMAGE tensor (B,H,W,C, 0..1 float)."""
        t = image_opt[0].detach().clamp(0, 1).cpu().numpy()
        h, w = t.shape[0], t.shape[1]
        out_image = torch.from_numpy(t.astype(np.float32))[None,]

        pil = Image.fromarray((t * 255.0).round().astype(np.uint8), "RGB")
        mask, save_name = self._load_mask_and_preview(pil, (w, h), mask_path, None)
        return self._finalize(out_image, mask, save_name)

    def _load_mask_and_preview(self, img, size, mask_path, img_path):
        """Load the mask (mask_path) + save the UI preview to temp."""
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

        # UI preview (shown on the node like LoadImage). If a mask exists,
        # composite a semi-transparent magenta overlay so the painted area is
        # visible directly on the node preview.
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
            preview_dir = folder_paths.get_temp_directory()
            os.makedirs(preview_dir, exist_ok=True)
            m = hashlib.sha256()
            if img_path:
                with open(img_path, "rb") as f:
                    m.update(f.read())
            else:
                buf = io.BytesIO()
                preview.save(buf, format="PNG", compress_level=1)
                m.update(buf.getvalue())
            # include the painted-mask state in the name, so the frontend
            # gets a NEW url (no stale cache) after every mask edit
            if mask_path:
                mpath = folder_paths.get_annotated_filepath(mask_path)
                if os.path.isfile(mpath):
                    m.update(str(os.path.getmtime(mpath)).encode())
            save_name = "fastmask_preview_%s.png" % m.hexdigest()[:16]
            # ALWAYS write the preview file. Previously the file-loader branch
            # only computed the name without saving -> /view 404 -> frontend
            # shows "failed to load image" and the node preview disappears.
            preview.save(os.path.join(preview_dir, save_name), format="PNG", compress_level=1)
        except Exception as e:
            print(f"[FastMask] preview save failed: {e}")
            save_name = None
        return out_mask, save_name

    def _finalize(self, out_image, out_mask, save_name):
        ui_images = (
            [{"filename": save_name, "subfolder": "", "type": "temp"}]
            if save_name
            else []
        )
        return {"ui": {"images": ui_images}, "result": (out_image, out_mask)}

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
