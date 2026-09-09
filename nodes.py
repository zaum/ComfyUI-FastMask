import hashlib
import io
import os
import time
import traceback

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths


class FastMaskEditor:
    """All-in-one image loader + mask editor, like the built-in LoadImage.

    Loads an image from the ComfyUI input directory (dropdown + upload button,
    same widgets/mechanism as LoadImage), outputs both the IMAGE and a MASK.
    Open the FastMask editor from the node button / right-click menu to paint
    the mask (full resolution on export, fast preview-res painting). An
    external MASK can be fed into mask_opt (e.g. from another node); it is
    used while no painted mask_path file is set."""

    @classmethod
    def INPUT_TYPES(s):
        try:
            input_dir = folder_paths.get_input_directory()
            files = [
                f
                for f in os.listdir(input_dir)
                if os.path.isfile(os.path.join(input_dir, f))
            ]
        except Exception as e:
            print(f"[FastMask] could not list input directory: {e}")
            files = []
        return {
            "required": {
                # image_upload: True -> the built-in frontend extension adds
                # the upload/refresh buttons and the preview to the node
                # (same mechanism as LoadImage)
                "image": (sorted(files), {"image_upload": True}),
                "mask_path": ("STRING", {"default": ""}),
            },
            # optional IMAGE input: when another node (e.g. LoadImage) output
            # is connected here, it overrides the dropdown-selected image.
            # optional MASK input: an external mask (first batch is used,
            # resized to the image). It applies while mask_path is empty;
            # once you paint in the editor, the painted file takes over.
            "optional": {
                "image_opt": ("IMAGE",),
                "mask_opt": ("MASK",),
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
        "mask. Outputs IMAGE and MASK (1.0 = masked area). A connected "
        "mask_opt input is used while no painted mask is set."
    )

    @classmethod
    def VALIDATE_INPUTS(s, image, mask_path="", **kwargs):
        # The image combo list is computed at node-definition time, but new
        # files can appear later (Ctrl+V paste -> input/paste/xxx.png, direct
        # upload). The default "value must be in list" validation would reject
        # those, so validate by file existence instead - same as LoadImage.
        # When image_opt is connected the dropdown value may be stale, so do
        # not reject the node: the tensor path overrides the file anyway.
        if kwargs.get("image_opt") is not None:
            return True
        if not folder_paths.exists_annotated_filepath(image):
            return f"Invalid image file: {image}"
        if mask_path:
            # Mask is optional; an empty value means "no mask yet". A set but
            # missing file is not fatal (the editor restores empty instead),
            # so only reject values that escape the input directory.
            try:
                mpath = folder_paths.get_annotated_filepath(mask_path)
                base = os.path.realpath(folder_paths.get_input_directory())
                if os.path.commonpath([base, os.path.realpath(mpath)]) != base:
                    return f"Invalid mask path: {mask_path}"
            except Exception:
                pass
        return True

    def load(self, image, mask_path="", image_opt=None, mask_opt=None):
        try:
            if image_opt is not None:
                return self._load_from_tensor(image_opt, mask_path, mask_opt)

            img_path = folder_paths.get_annotated_filepath(image)
            img = Image.open(img_path)
            img = ImageOps.exif_transpose(img)
            if img.mode in ("I", "I;16", "I;16B", "I;16L"):
                img = img.point(lambda i: i * (1 / 255)).convert("L")

            out_image = img.convert("RGB")
            w, h = out_image.size
            out_image = np.array(out_image).astype(np.float32) / 255.0
            out_image = torch.from_numpy(out_image)[None,]

            mask, ui_images = self._load_mask_and_preview(
                img, (w, h), mask_path, img_path, image, mask_opt
            )
            return self._finalize(out_image, mask, ui_images)
        except Exception as e:
            print(f"[FastMask] load() failed: {e}")
            traceback.print_exc()
            # Always return a valid preview so the node doesn't show "failed to load".
            return self._error_fallback(image, image_opt)

    def _error_fallback(self, image, image_opt):
        """Bulletproof fallback: never raises, always returns valid tensors."""
        try:
            preview_dir = os.path.join(folder_paths.get_input_directory(), "fastmask")
            os.makedirs(preview_dir, exist_ok=True)
        except Exception:
            preview_dir = None
        # Unique name: full ms timestamp, no modulo collision.
        save_name = f"fastmask_error_{int(time.time() * 1000)}.png"
        w, h = 256, 256
        out_image = None
        try:
            if image_opt is not None:
                t = self._tensor_to_hw3(image_opt)
                if t is not None:
                    h, w = t.shape[0], t.shape[1]
                    out_image = torch.from_numpy(t.astype(np.float32))[None,]
        except Exception:
            out_image = None
        err_img = Image.new("RGB", (w, h), (64, 0, 0))
        ui_images = []
        if preview_dir is not None:
            try:
                err_img.save(os.path.join(preview_dir, save_name), format="PNG", compress_level=1)
                ui_images = [{"filename": save_name, "subfolder": "fastmask", "type": "input"}]
            except Exception:
                pass
        if out_image is None:
            out_image = torch.zeros((1, h, w, 3), dtype=torch.float32)
        out_mask = torch.zeros((1, h, w), dtype=torch.float32)
        return {"ui": {"images": ui_images}, "result": (out_image, out_mask)}

    @staticmethod
    def _tensor_to_hw3(image_opt):
        """Normalize any IMAGE tensor to HWC float32 RGB, or None if unusable."""
        try:
            import torch as _torch

            t = image_opt
            if isinstance(t, _torch.Tensor):
                if t.ndim == 4:
                    if t.shape[0] < 1:
                        return None
                    t = t[0]
                elif t.ndim == 3:
                    pass
                elif t.ndim == 2:
                    t = t.unsqueeze(-1)
                else:
                    return None
                t = t.detach().clamp(0, 1).cpu().numpy()
            else:
                t = np.asarray(t)
                if t.ndim == 4:
                    if t.shape[0] < 1:
                        return None
                    t = t[0]
                t = np.clip(t, 0.0, 1.0)
            if t.ndim == 2:
                t = np.stack([t, t, t], axis=-1)
            elif t.ndim == 3:
                c = t.shape[2] if t.shape[2] <= 4 else t.shape[0]
                if t.shape[0] in (1, 3, 4) and t.shape[2] not in (1, 3, 4):
                    # BCHW-style tensor: transpose to HWC.
                    t = np.transpose(t, (1, 2, 0))
                c = t.shape[2]
                if c == 4:
                    t = t[:, :, :3]
                elif c == 1:
                    t = np.repeat(t, 3, axis=2)
                elif c != 3:
                    return None
            else:
                return None
            return t.astype(np.float32)
        except Exception:
            return None

    def _load_from_tensor(self, image_opt, mask_path="", mask_opt=None):
        """Works from a connected IMAGE tensor (B,H,W,C, 0..1 float)."""
        t = self._tensor_to_hw3(image_opt)
        if t is None:
            raise ValueError("Unsupported image_opt tensor shape")
        h, w = t.shape[0], t.shape[1]
        out_image = torch.from_numpy(t.astype(np.float32))[None,]

        pil = Image.fromarray((t * 255.0).round().astype(np.uint8))
        mask, ui_images = self._load_mask_and_preview(
            pil, (w, h), mask_path, None, None, mask_opt
        )
        return self._finalize(out_image, mask, ui_images)

    @staticmethod
    def _tensor_to_hw_mask(mask_opt, size):
        """Normalize any MASK tensor to float32 0..1 (H,W), resized to size.

        Accepts (B,H,W), (H,W) and (B,H,W,1)/(B,1,H,W) variants; upstream
        masks often differ in resolution (e.g. 64x64 latent masks), so the
        result is resized with bilinear filtering. Returns None if unusable.
        """
        try:
            import torch as _torch

            w, h = size
            if isinstance(mask_opt, _torch.Tensor):
                t = mask_opt.detach().float().cpu()
            else:
                t = torch.as_tensor(np.asarray(mask_opt), dtype=torch.float32)
            while t.ndim > 3:
                # (B,H,W,1) -> (B,H,W); (B,1,H,W) -> (B,H,W)
                if t.shape[-1] == 1:
                    t = t[..., 0]
                elif t.shape[1] == 1:
                    t = t[:, 0]
                else:
                    t = t[0]
            if t.ndim == 3:
                if t.shape[0] < 1:
                    return None
                t = t[0]
            if t.ndim != 2:
                return None
            t = t.clamp(0, 1).unsqueeze(0).unsqueeze(0)
            t = torch.nn.functional.interpolate(
                t, size=(h, w), mode="bilinear", align_corners=False
            )
            return t[0, 0].numpy().astype(np.float32)
        except Exception as e:
            print(f"[FastMask] mask_opt normalize failed: {e}")
            return None

    def _source_ui(self, image_value):
        """Build the ui.images reference for the ORIGINAL source image so the
        node always shows the real image (never a fragile generated preview)."""
        if not image_value:
            return None
        parts = str(image_value).split("/")
        fname = parts[-1]
        sub = "/".join(parts[:-1])
        return [{"filename": fname, "subfolder": sub, "type": "input"}]

    @staticmethod
    def _read_mask_array(mpath, size):
        """Read a mask file to float32 0..1. Supports RGBA alpha and L/RGB luminance."""
        w, h = size
        m = Image.open(mpath)
        if m.size != (w, h):
            # Binary masks must use NEAREST so edges stay sharp.
            filt = Image.NEAREST if m.mode in ("1", "L", "P") else Image.BILINEAR
            m = m.resize((w, h), filt)
        if "A" in m.getbands():
            m = m.convert("RGBA")
            return np.asarray(m)[:, :, 3].astype(np.float32) / 255.0
        # No alpha channel (L/RGB mask): use luminance instead of solid white.
        return np.asarray(m.convert("L")).astype(np.float32) / 255.0

    def _load_mask_and_preview(self, img, size, mask_path, img_path, image_value=None, mask_opt=None):
        """Load the mask (mask_path) and decide what to show on the node.

        Precedence: painted mask_path file > connected mask_opt tensor > empty.
        Once you paint in the editor, the painted file takes over the external
        input (clear the mask_path widget to go back to the external mask).
        For a file-based image we simply show the ORIGINAL source image on the
        node (reliable, never disappears). When the image comes from a connected
        tensor (no source file) we generate a preview PNG instead.
        """
        w, h = size
        mask = None
        if mask_path:
            try:
                mpath = folder_paths.get_annotated_filepath(mask_path)
                if os.path.isfile(mpath):
                    mask = self._read_mask_array(mpath, (w, h))
                else:
                    print(f"[FastMask] mask file not found: {mpath}")
            except Exception as e:
                print(f"[FastMask] mask load failed: {e}")
        if mask is None and mask_opt is not None:
            mask = self._tensor_to_hw_mask(mask_opt, (w, h))
            if mask is not None:
                print(f"[FastMask] mask: using connected mask_opt input size={w}x{h}")
        if mask is None:
            # No painted mask yet -> empty mask (nothing is masked).
            out_mask = torch.zeros((h, w), dtype=torch.float32)
        else:
            out_mask = torch.from_numpy(mask).to(torch.float32)
        out_mask = out_mask.unsqueeze(0)
        painted_pct = float((out_mask[0] > 0.5).float().mean()) * 100.0
        print(f"[FastMask] mask: path={mask_path!r} painted={painted_pct:.1f}% size={w}x{h}")

        # File-based image: show the original on the node (always available).
        if image_value:
            ui_images = self._source_ui(image_value)
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
            preview_dir = os.path.join(folder_paths.get_input_directory(), "fastmask")
            os.makedirs(preview_dir, exist_ok=True)
            buf = io.BytesIO()
            preview.save(buf, format="PNG", compress_level=1)
            data = buf.getvalue()
            m = hashlib.sha256(data)
            if mask is not None:
                # Hash the mask content, not just mtime (fast saves can share mtime).
                m.update(np.ascontiguousarray((np.clip(mask, 0.0, 1.0) * 255.0)).tobytes())
            save_name = "fastmask_preview_%s.png" % m.hexdigest()[:16]
            dest = os.path.join(preview_dir, save_name)
            if not os.path.isfile(dest):
                # Atomic write so concurrent runs never read a partial file.
                tmp = dest + f".tmp{os.getpid()}"
                with open(tmp, "wb") as f:
                    f.write(data)
                try:
                    os.replace(tmp, dest)
                except Exception:
                    try:
                        os.remove(tmp)
                    except Exception:
                        pass
            self._prune_previews(preview_dir, keep=50)
        except Exception as e:
            print(f"[FastMask] preview save failed: {e}")
            save_name = None
        return out_mask, ([{"filename": save_name, "subfolder": "fastmask", "type": "input"}] if save_name else [])

    @staticmethod
    def _prune_previews(preview_dir, keep=50):
        """Keep the preview/error cache bounded; best-effort only."""
        try:
            files = [
                os.path.join(preview_dir, f)
                for f in os.listdir(preview_dir)
                if f.startswith(("fastmask_preview_", "fastmask_error_"))
            ]
            if len(files) <= keep:
                return
            files.sort(key=lambda p: os.path.getmtime(p))
            for p in files[: len(files) - keep]:
                try:
                    os.remove(p)
                except Exception:
                    pass
        except Exception:
            pass

    def _finalize(self, out_image, out_mask, ui_images):
        return {"ui": {"images": ui_images or []}, "result": (out_image, out_mask)}

    @classmethod
    def IS_CHANGED(s, image, mask_path="", image_opt=None, mask_opt=None, **kwargs):
        # Fast, crash-proof change detection: mtime + size instead of hashing
        # the whole file on every prompt. Accepts image_opt/mask_opt (tensor
        # inputs) so a connected upstream image/mask does not raise TypeError;
        # tensor content itself is tracked by ComfyUI via the link, the widgets
        # are ignored in that case.
        try:
            if image_opt is not None:
                h = "tensor"
            else:
                img_path = folder_paths.get_annotated_filepath(image)
                try:
                    stt = os.stat(img_path)
                    h = f"{stt.st_mtime_ns}:{stt.st_size}"
                except Exception:
                    h = str(image)
            if mask_path:
                try:
                    mpath = folder_paths.get_annotated_filepath(mask_path)
                    if os.path.isfile(mpath):
                        # a painted-mask change also re-runs the node
                        stt = os.stat(mpath)
                        h += f":{stt.st_mtime_ns}:{stt.st_size}"
                except Exception:
                    h += f":{mask_path}"
            elif mask_opt is not None:
                h += ":mask-tensor"
            return h
        except Exception:
            return str(time.time_ns())


NODE_CLASS_MAPPINGS = {
    "FastMaskEditor": FastMaskEditor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "FastMaskEditor": "FastMask Editor",
}
