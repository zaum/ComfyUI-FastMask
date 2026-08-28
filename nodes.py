import hashlib
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
                # image_upload: True -> a beepitett frontend extension
                # upload/refresh gombot es preview-t rak a node-ra
                # (ugyanaz, mint a LoadImage-nel)
                "image": (sorted(files), {"image_upload": True}),
                "mask_path": ("STRING", {"default": ""}),
            }
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

    def load(self, image, mask_path=""):
        img_path = folder_paths.get_annotated_filepath(image)
        img = Image.open(img_path)
        img = ImageOps.exif_transpose(img)
        if img.mode == "I":
            img = img.point(lambda i: i * (1 / 255)).convert("L")

        out_image = img.convert("RGB")
        w, h = out_image.size
        out_image = np.array(out_image).astype(np.float32) / 255.0
        out_image = torch.from_numpy(out_image)[None,]

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
            # Meg nincs festett maszk -> ures maszk (semmi nincs maszkolva).
            out_mask = torch.zeros((h, w), dtype=torch.float32)
        else:
            out_mask = torch.from_numpy(mask).to(torch.float32)
        out_mask = out_mask.unsqueeze(0)

        # UI preview (a node-on jelenik meg), mint a LoadImage-nel
        preview = img.convert("RGB")
        save_name = None
        try:
            preview_dir = folder_paths.get_temp_directory()
            os.makedirs(preview_dir, exist_ok=True)
            m = hashlib.sha256()
            with open(img_path, "rb") as f:
                m.update(f.read())
            save_name = f"fastmask_preview_{m.hexdigest()[:16]}.png"
            preview.save(os.path.join(preview_dir, save_name), compress_level=1)
        except Exception as e:
            print(f"[FastMask] preview save failed: {e}")
            save_name = None

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
                # a festett maszk valtozasa is ujrafuttatja a node-ot
                h += ":" + str(os.path.getmtime(mpath))
        return h


NODE_CLASS_MAPPINGS = {
    "FastMaskEditor": FastMaskEditor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "FastMaskEditor": "FastMask Editor",
}
