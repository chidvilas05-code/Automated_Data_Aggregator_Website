import os
import subprocess
import sys

# Ensure Pillow is installed
try:
    from PIL import Image
except ImportError:
    print("Pillow not found. Installing Pillow...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "Pillow"])
    from PIL import Image

def generate_icons():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    logo_path = os.path.join(project_root, 'frontend', 'public', 'logo.jpg')
    public_dir = os.path.join(project_root, 'frontend', 'public')

    if not os.path.exists(logo_path):
        print(f"Error: Logo file not found at {logo_path}")
        return

    print(f"Found logo at {logo_path}")
    img = Image.open(logo_path)

    # Convert to PNG and generate different sizes
    sizes = {
        'pwa-192x192.png': (192, 192),
        'pwa-512x512.png': (512, 512),
        'apple-touch-icon.png': (180, 180)
    }

    for filename, size in sizes.items():
        out_path = os.path.join(public_dir, filename)
        resized_img = img.resize(size, Image.Resampling.LANCZOS)
        resized_img.save(out_path, 'PNG')
        print(f"Generated {out_path} ({size[0]}x{size[1]})")

if __name__ == '__main__':
    generate_icons()
