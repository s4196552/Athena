"""
make_mock_library.py
--------------------
Generates a large, realistic mock file library for Hermes Media (game company)
for use as a demo data set for the Athena media indexing tool.

Run:  python make_mock_library.py
Output: ./mock_library/HermesMedia/  (hundreds of files, many subdirectories)
"""

import os
import random
import struct
import zlib
import json
import csv
import io
import subprocess
import tempfile
from pathlib import Path
from datetime import datetime, timedelta

from PIL import Image
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet
from docx import Document
import openpyxl
from pptx import Presentation

random.seed(42)

ROOT = Path("mock_library") / "HermesMedia"

# ---------------------------------------------------------------------------
# Valid binary and document file builders using real libraries
# ---------------------------------------------------------------------------

def make_png(width: int = 64, height: int = 64, color: tuple = None) -> bytes:
    """Build a valid PNG using Pillow."""
    if color is None:
        color = (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
    img = Image.new("RGB", (width, height), color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def make_jpeg(width: int = 64, height: int = 64) -> bytes:
    """Valid JPEG using Pillow."""
    color = (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
    img = Image.new("RGB", (width, height), color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def make_gif() -> bytes:
    """Valid GIF using Pillow."""
    img = Image.new("RGB", (1, 1), (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)))
    buf = io.BytesIO()
    img.save(buf, format="GIF")
    return buf.getvalue()


def make_wav(duration_s: float = 1.0, sample_rate: int = 44100) -> bytes:
    """Valid WAV using ffmpeg."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        tf_name = tf.name
    cmd = [
        "ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r={sample_rate}:cl=mono", "-t", str(duration_s), tf_name
    ]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        with open(tf_name, "rb") as f:
            data = f.read()
    finally:
        if os.path.exists(tf_name):
            os.unlink(tf_name)
    return data


def make_ogg(duration_s: float = 1.0) -> bytes:
    """Valid OGG using ffmpeg."""
    with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as tf:
        tf_name = tf.name
    cmd = [
        "ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", str(duration_s), "-c:a", "libvorbis", tf_name
    ]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        with open(tf_name, "rb") as f:
            data = f.read()
    finally:
        if os.path.exists(tf_name):
            os.unlink(tf_name)
    return data


def make_mp3(duration_s: float = 1.0) -> bytes:
    """Valid MP3 using ffmpeg."""
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tf:
        tf_name = tf.name
    cmd = [
        "ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", str(duration_s), "-c:a", "libmp3lame", tf_name
    ]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        with open(tf_name, "rb") as f:
            data = f.read()
    finally:
        if os.path.exists(tf_name):
            os.unlink(tf_name)
    return data


def make_flac(duration_s: float = 1.0) -> bytes:
    """Valid FLAC using ffmpeg."""
    with tempfile.NamedTemporaryFile(suffix=".flac", delete=False) as tf:
        tf_name = tf.name
    cmd = [
        "ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", str(duration_s), "-c:a", "flac", tf_name
    ]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        with open(tf_name, "rb") as f:
            data = f.read()
    finally:
        if os.path.exists(tf_name):
            os.unlink(tf_name)
    return data


def make_mp4(duration_s: float = 5.0) -> bytes:
    """Valid MP4 using ffmpeg."""
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tf:
        tf_name = tf.name
    cmd = [
        "ffmpeg", "-y", "-f", "lavfi", "-i", f"testsrc=duration={duration_s}:size=64x64:rate=30",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", tf_name
    ]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        with open(tf_name, "rb") as f:
            data = f.read()
    finally:
        if os.path.exists(tf_name):
            os.unlink(tf_name)
    return data


def make_mov(duration_s: float = 5.0) -> bytes:
    """Valid MOV using ffmpeg."""
    with tempfile.NamedTemporaryFile(suffix=".mov", delete=False) as tf:
        tf_name = tf.name
    cmd = [
        "ffmpeg", "-y", "-f", "lavfi", "-i", f"testsrc=duration={duration_s}:size=64x64:rate=30",
        "-c:v", "prores_ks", tf_name
    ]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        with open(tf_name, "rb") as f:
            data = f.read()
    finally:
        if os.path.exists(tf_name):
            os.unlink(tf_name)
    return data


def make_webm(duration_s: float = 5.0) -> bytes:
    """Valid WebM using ffmpeg."""
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tf:
        tf_name = tf.name
    cmd = [
        "ffmpeg", "-y", "-f", "lavfi", "-i", f"testsrc=duration={duration_s}:size=64x64:rate=30",
        "-c:v", "libvpx", tf_name
    ]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        with open(tf_name, "rb") as f:
            data = f.read()
    finally:
        if os.path.exists(tf_name):
            os.unlink(tf_name)
    return data


def make_pdf(title: str = "Document", author: str = "Hermes Media", pages: int = 5) -> bytes:
    """Valid PDF using reportlab."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter)
    styles = getSampleStyleSheet()
    story = [
        Paragraph(title, styles['Title']),
        Spacer(1, 12),
        Paragraph(f"Author: {author}", styles['Normal']),
        Spacer(1, 12),
        Paragraph(f"Total Pages: {pages}", styles['Normal']),
    ]
    doc.build(story)
    return buf.getvalue()


def make_docx(title: str = "Document") -> bytes:
    """Valid DOCX using python-docx."""
    doc = Document()
    doc.add_heading(title, 0)
    doc.add_paragraph("This is a mock document generated for Hermes Media.")
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def make_xlsx() -> bytes:
    """Valid XLSX using openpyxl."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Report"
    ws['A1'] = "Metric"
    ws['B1'] = "Value"
    ws.append(["Sample Data", 42])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def make_pptx(title: str = "Presentation") -> bytes:
    """Valid PPTX using python-pptx."""
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[0])
    slide.shapes.title.text = title
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()


def make_txt(content: str) -> bytes:
    return content.encode("utf-8")


def make_csv_data(rows: list) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerows(rows)
    return buf.getvalue().encode("utf-8")


def make_json_data(data) -> bytes:
    return json.dumps(data, indent=2).encode("utf-8")


def make_xml(content: str) -> bytes:
    return f'<?xml version="1.0" encoding="UTF-8"?>\n{content}'.encode("utf-8")


def make_psd(width: int = 256, height: int = 256) -> bytes:
    header = struct.pack(
        ">4sHHIHHHH",
        b"8BPS", 1, 0, 0, 1, 8, height, width,
    )
    return header + random.randbytes(random.randint(4096, 65536))


def make_svg(title: str = "icon") -> bytes:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
  <title>{title}</title>
  <rect width="256" height="256" fill="#{random.randint(0,0xFFFFFF):06X}"/>
  <circle cx="128" cy="128" r="{random.randint(32,100)}" fill="#{random.randint(0,0xFFFFFF):06X}"/>
</svg>""".encode()


def make_fbx() -> bytes:
    return b"Kaydara FBX Binary  \x00\x1a\x00" + random.randbytes(random.randint(8192, 262144))


def make_obj(mesh_name: str = "mesh") -> bytes:
    verts = "\n".join(
        f"v {random.uniform(-1,1):.4f} {random.uniform(-1,1):.4f} {random.uniform(-1,1):.4f}"
        for _ in range(random.randint(8, 64))
    )
    return f"# Hermes Media OBJ\no {mesh_name}\n{verts}\n".encode()


def make_lua(name: str = "script") -> bytes:
    return f"""-- {name}.lua  (Hermes Media)
local M = {{}}

function M.init()
    print("Initializing {name}")
end

function M.update(dt)
    -- game logic here
end

return M
""".encode()


def make_csharp(class_name: str = "GameScript") -> bytes:
    return f"""// {class_name}.cs  (Hermes Media)
using UnityEngine;

public class {class_name} : MonoBehaviour
{{
    void Start()
    {{
        Debug.Log("{class_name} started");
    }}

    void Update()
    {{
        // frame logic
    }}
}}
""".encode()


def make_markdown(title: str, body: str) -> bytes:
    return f"# {title}\n\n{body}\n".encode()


# ---------------------------------------------------------------------------
# Shared constants
# ---------------------------------------------------------------------------

GAMES = [
    "Vortex_Rising",
    "NeonCitadel",
    "EchoWraith",
    "SolarVanguard",
    "CrimsonSerpent",
    "Project_Orakel",
    "Spectral_Drift",
]

TEAM_MEMBERS = [
    "aria.chen", "dex.morgan", "lena.vasquez", "kurt.paige",
    "soo.jin.park", "omar.rashid", "fiona.bell", "marcus.thorn",
]


def rnd_date() -> str:
    base = datetime(2022, 1, 1)
    delta = timedelta(days=random.randint(0, 900))
    return (base + delta).strftime("%Y%m%d")


def rnd_version() -> str:
    return f"v{random.randint(0,3)}.{random.randint(0,9)}.{random.randint(0,20)}"


def write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    print(f"  {path.relative_to(ROOT)}")


# ---------------------------------------------------------------------------
# Section generators
# ---------------------------------------------------------------------------

def gen_brand_identity():
    base = ROOT / "Brand_Identity"
    print(f"\n[Brand_Identity]")

    logos = base / "Logos"
    for variant in ["primary", "secondary", "stacked", "horizontal", "icon_only", "monochrome", "reversed"]:
        write(logos / f"hermes_logo_{variant}.png", make_png(512, 256, color=(200, 60, 20)))
        write(logos / f"hermes_logo_{variant}.svg", make_svg(f"hermes_{variant}"))

    for game in GAMES[:4]:
        for variant in ["full", "icon", "wordmark"]:
            write(logos / "Games" / game / f"{game.lower()}_{variant}.png", make_png(256, 256))
            write(logos / "Games" / game / f"{game.lower()}_{variant}.svg", make_svg(f"{game}_{variant}"))

    write(base / "Guidelines" / "Hermes_Media_Brand_Guide_2024.pdf",
          make_pdf("Hermes Media Brand Guide", "Brand Team", 48))
    write(base / "Guidelines" / "Hermes_Media_Brand_Guide_2024.docx",
          make_docx("Hermes Media Brand Guide 2024"))
    write(base / "Guidelines" / "Color_Palette.pdf", make_pdf("Color Palette", "Brand Team", 6))
    write(base / "Guidelines" / "Typography_Guide.pdf", make_pdf("Typography", "Brand Team", 12))

    press = base / "Press_Kit"
    for game in GAMES[:3]:
        write(press / game / f"{game}_PressKit_2024.pdf", make_pdf(f"{game} Press Kit", "PR Team", 20))
        write(press / game / f"{game}_FactSheet.docx", make_docx(f"{game} Fact Sheet"))
        write(press / game / f"{game}_Hero.jpg", make_jpeg(1920, 1080))
        write(press / game / f"{game}_Cover.png", make_png(1280, 720))
        for i in range(1, 6):
            write(press / game / "Screenshots" / f"screenshot_{i:02d}.jpg", make_jpeg())


def gen_art_assets():
    base = ROOT / "Art_Assets"
    print(f"\n[Art_Assets]")

    for game in GAMES:
        game_art = base / game

        # Concept art
        concepts = game_art / "Concept_Art"
        for subject in ["environment", "character", "creature", "vehicle", "prop", "UI", "logo_concept"]:
            for rev in range(1, random.randint(2, 5)):
                write(concepts / f"{subject}_{rev:02d}.psd", make_psd(1024, 768))
                write(concepts / f"{subject}_{rev:02d}_export.png", make_png(1024, 768))

        # Textures
        tex = game_art / "Textures"
        tex_types = [
            ("albedo", 1024, 1024), ("normal", 1024, 1024),
            ("roughness", 512, 512), ("metallic", 512, 512),
            ("ao", 512, 512), ("emissive", 256, 256),
            ("height", 512, 512),
        ]
        for category in ["environment", "characters", "props", "UI"]:
            for idx in range(1, random.randint(4, 10)):
                stem = f"T_{category}_{idx:03d}"
                for tex_kind, tw, th in random.sample(tex_types, k=random.randint(2, 5)):
                    write(tex / category / f"{stem}_{tex_kind}.png", make_png(tw, th))

        # UI sprites
        ui_base = game_art / "UI"
        for panel in ["HUD", "Menus", "Icons", "Buttons", "Overlays"]:
            for i in range(1, random.randint(3, 8)):
                write(ui_base / panel / f"{panel.lower()}_{i:02d}.png", make_png(128, 128))
                if random.random() < 0.3:
                    write(ui_base / panel / f"{panel.lower()}_{i:02d}.svg", make_svg(f"{panel}_{i}"))

        # Sprite sheets
        for sheet in ["player_idle", "player_run", "player_attack", "enemy_walk", "vfx_explosion"]:
            write(game_art / "Spritesheets" / f"{sheet}.png", make_png(512, 512))
            write(game_art / "Spritesheets" / f"{sheet}.json",
                  make_json_data({"sheet": sheet, "frames": random.randint(4, 32), "game": game}))

        # 3D Models
        models = game_art / "3D_Models"
        for category in ["Characters", "Environment", "Props", "Vehicles"]:
            for i in range(1, random.randint(3, 8)):
                stem = f"{category[:3].upper()}_{i:03d}"
                write(models / category / f"{stem}.fbx", make_fbx())
                write(models / category / f"{stem}.obj", make_obj(stem))
                write(models / category / f"{stem}_LOD0.fbx", make_fbx())
                write(models / category / f"{stem}_LOD1.fbx", make_fbx())
                write(models / category / f"{stem}_thumbnail.png", make_png(256, 256))

        # Animations
        anims = game_art / "Animations"
        for anim in ["idle", "walk", "run", "jump", "attack", "death", "victory", "hit", "crouch"]:
            write(anims / f"{anim}.fbx", make_fbx())


def gen_audio():
    base = ROOT / "Audio"
    print(f"\n[Audio]")

    for game in GAMES:
        game_audio = base / game

        # Music
        music = game_audio / "Music"
        for track in ["main_theme", "battle_01", "battle_02", "ambient_forest", "ambient_city",
                      "boss_theme", "victory", "defeat", "menu_loop", "credits", "cutscene_01"]:
            write(music / f"{track}.wav",  make_wav(random.uniform(30, 180)))
            write(music / f"{track}.ogg",  make_ogg(random.uniform(30, 180)))
            if random.random() < 0.5:
                write(music / f"{track}.flac", make_flac(random.uniform(30, 180)))
            if random.random() < 0.3:
                write(music / f"{track}.mp3", make_mp3(random.uniform(30, 180)))

        # SFX
        sfx = game_audio / "SFX"
        sfx_categories = {
            "Weapons":    ["gunshot", "reload", "sword_swing", "arrow_release",
                           "explosion_small", "explosion_large", "ricochet", "shell_drop"],
            "Footsteps":  ["concrete_walk", "concrete_run", "grass_walk", "grass_run",
                           "metal_walk", "wood_walk", "gravel_run", "water_splash"],
            "UI":         ["button_click", "button_hover", "notification", "achievement",
                           "menu_open", "menu_close", "error", "success", "countdown"],
            "Ambience":   ["wind_light", "wind_heavy", "rain_light", "rain_heavy",
                           "crowd_distant", "machinery", "fire_crackling", "cave_drip"],
            "Characters": ["grunt", "shout", "laugh", "pain_01", "pain_02", "death",
                           "taunt", "celebrate", "breathing"],
            "Environment":["door_open", "door_close", "switch_flip", "lever_pull",
                           "water_drip", "electricity_crackle", "alarm"],
        }
        for category, sounds in sfx_categories.items():
            for sound in sounds:
                for variant in range(1, random.randint(2, 4)):
                    write(sfx / category / f"{sound}_{variant:02d}.wav",
                          make_wav(random.uniform(0.2, 3.0)))

        # Voice lines
        voice = game_audio / "Voice"
        for lang in ["EN", "JP", "DE"]:
            for char in ["protagonist", "antagonist", "npc_merchant", "npc_guard"]:
                for line in range(1, random.randint(5, 15)):
                    write(voice / lang / char / f"line_{line:03d}.wav",
                          make_wav(random.uniform(1.0, 8.0)))


def gen_video():
    base = ROOT / "Video"
    print(f"\n[Video]")

    for game in GAMES:
        game_vid = base / game

        trailers = game_vid / "Trailers"
        for trailer in ["announce_trailer", "gameplay_trailer", "story_trailer", "launch_trailer"]:
            write(trailers / f"{trailer}_4K.mp4",    make_mp4(random.uniform(60, 180)))
            write(trailers / f"{trailer}_1080p.mp4", make_mp4(random.uniform(60, 180)))
            write(trailers / f"{trailer}_720p.mp4",  make_mp4(random.uniform(60, 180)))
            write(trailers / f"{trailer}_master.mov", make_mov(random.uniform(60, 180)))

        cutscenes = game_vid / "Cutscenes"
        for i in range(1, random.randint(4, 10)):
            write(cutscenes / f"cutscene_{i:02d}_final.mp4", make_mp4(random.uniform(30, 120)))
            write(cutscenes / f"cutscene_{i:02d}_raw.mov",   make_mov(random.uniform(30, 120)))

        write(game_vid / "Tutorial" / "tutorial_01_movement.mp4", make_mp4(15.0))
        write(game_vid / "Tutorial" / "tutorial_02_combat.mp4",   make_mp4(20.0))
        write(game_vid / "Tutorial" / "tutorial_03_crafting.mp4", make_mp4(18.0))
        write(game_vid / "Demo" / f"{game}_demo_raw.mov",  make_mov(random.uniform(300, 600)))
        write(game_vid / "Demo" / f"{game}_demo_final.mp4", make_mp4(random.uniform(300, 600)))

    # Company-wide
    corporate = base / "_Corporate"
    for year in [2022, 2023, 2024]:
        write(corporate / "Events" / f"gamescom_{year}_footage.mp4",
              make_mp4(random.uniform(120, 600)))
        write(corporate / "Events" / f"e3_{year}_booth.mov",
              make_mov(random.uniform(120, 400)))
    write(corporate / "HR" / "onboarding_intro.mp4",   make_mp4(600))
    write(corporate / "HR" / "safety_training.mp4",    make_mp4(1200))
    write(corporate / "Marketing" / "company_reel_2024.mp4",        make_mp4(300))
    write(corporate / "Marketing" / "hermes_documentary.mov",  make_mov(1800))

    broll = base / "_BRoll"
    for i in range(1, 21):
        write(broll / f"broll_{i:03d}.mp4", make_mp4(random.uniform(5, 30)))
        if random.random() < 0.4:
            write(broll / f"broll_{i:03d}.webm", make_webm(random.uniform(5, 30)))


def gen_documents():
    base = ROOT / "Documents"
    print(f"\n[Documents]")

    gdd = base / "Game_Design_Documents"
    for game in GAMES:
        d = gdd / game
        write(d / f"{game}_GDD_v1.0.pdf",          make_pdf(f"{game} GDD", "Design Team", 120))
        write(d / f"{game}_GDD_v1.0.docx",          make_docx(f"{game} GDD"))
        write(d / f"{game}_GDD_v2.0.docx",          make_docx(f"{game} GDD v2"))
        write(d / f"{game}_Mechanics_Overview.pdf", make_pdf("Mechanics", "Design Team", 30))
        write(d / f"{game}_Level_Design_Guide.pdf", make_pdf("Level Design", "Level Team", 50))
        write(d / f"{game}_Narrative_Bible.docx",   make_docx(f"{game} Narrative Bible"))
        write(d / f"{game}_Character_Bible.pdf",    make_pdf("Characters", "Narrative Team", 60))
        write(d / f"{game}_UI_UX_Spec.pdf",         make_pdf("UI/UX Spec", "UX Team", 40))
        write(d / f"{game}_Economy_Design.xlsx",    make_xlsx())

    tech = base / "Technical"
    for game in GAMES:
        d = tech / game
        write(d / f"{game}_TDD.pdf",            make_pdf(f"{game} TDD", "Engineering", 80))
        write(d / f"{game}_Architecture.docx",  make_docx(f"{game} Architecture"))
        write(d / f"{game}_API_Reference.pdf",  make_pdf("API Reference", "Engineering", 200))
        write(d / f"{game}_Perf_Report.pdf",    make_pdf("Perf Report", "QA", 20))
        write(d / f"{game}_Build_Pipeline.docx", make_docx("Build Pipeline"))
        write(d / f"{game}_Profiling_Data.xlsx", make_xlsx())

    pm = base / "Project_Management"
    for game in GAMES:
        d = pm / game
        write(d / "Roadmap_2024.pdf",    make_pdf("Roadmap", "PM Team", 10))
        write(d / "Sprint_Backlog.xlsx", make_xlsx())
        write(d / "Risk_Register.xlsx",  make_xlsx())
        write(d / "Milestone_Plan.xlsx", make_xlsx())
        write(d / "Post_Mortem.docx",    make_docx(f"{game} Post Mortem"))
        write(d / "Budget_Overview.xlsx", make_xlsx())

    qa = base / "QA"
    for game in GAMES:
        d = qa / game
        write(d / "Test_Plan.docx",           make_docx(f"{game} Test Plan"))
        write(d / "Bug_Report_Template.docx", make_docx("Bug Report Template"))
        write(d / "QA_Sign_Off.pdf",          make_pdf("QA Sign Off", "QA Lead", 5))
        bug_rows = [["ID","Title","Severity","Status","Assignee","Date"]]
        for i in range(1, random.randint(50, 200)):
            bug_rows.append([
                f"BUG-{i:04d}",
                f"Issue in {random.choice(['collision','audio','rendering','AI','UI','physics'])}",
                random.choice(["Critical","High","Medium","Low"]),
                random.choice(["Open","In Progress","Closed","Won't Fix"]),
                random.choice(TEAM_MEMBERS),
                rnd_date(),
            ])
        write(d / "Bug_Tracker_Export.csv", make_csv_data(bug_rows))

    legal = base / "Legal"
    for doc in ["NDA_Template", "Contractor_Agreement", "Publisher_Agreement",
                "IP_Assignment", "EULA_Template", "Privacy_Policy"]:
        write(legal / f"{doc}.docx", make_docx(doc.replace("_"," ")))
        write(legal / f"{doc}.pdf",  make_pdf(doc, "Legal Dept", random.randint(8, 30)))

    finance = base / "Finance"
    for year in [2022, 2023, 2024]:
        for q in ["Q1","Q2","Q3","Q4"]:
            write(finance / str(year) / f"HermesMedia_{q}_{year}_FinancialReport.xlsx", make_xlsx())
            write(finance / str(year) / f"HermesMedia_{q}_{year}_BudgetActuals.xlsx",   make_xlsx())
    write(finance / "Annual_Reports" / "HermesMedia_Annual_2022.pdf",
          make_pdf("Annual Report 2022", "Finance", 40))
    write(finance / "Annual_Reports" / "HermesMedia_Annual_2023.pdf",
          make_pdf("Annual Report 2023", "Finance", 44))

    hr = base / "HR"
    write(hr / "Employee_Handbook_2024.pdf",           make_pdf("Employee Handbook", "HR", 80))
    write(hr / "Org_Chart_2024.pdf",                   make_pdf("Org Chart", "HR", 4))
    write(hr / "Job_Descriptions" / "Senior_Game_Designer.docx", make_docx("Senior Game Designer JD"))
    write(hr / "Job_Descriptions" / "Lead_Programmer.docx",       make_docx("Lead Programmer JD"))
    write(hr / "Job_Descriptions" / "Art_Director.docx",          make_docx("Art Director JD"))
    write(hr / "Onboarding" / "Day_1_Checklist.docx",             make_docx("Day 1 Checklist"))

    mkt = base / "Marketing"
    for game in GAMES[:4]:
        d = mkt / game
        write(d / "Marketing_Plan.pdf",           make_pdf(f"{game} Marketing Plan", "Marketing", 25))
        write(d / "Social_Media_Calendar.xlsx",   make_xlsx())
        write(d / "Press_Release_Announce.docx",  make_docx(f"{game} Press Release"))
        write(d / "Media_Kit.pdf",                make_pdf(f"{game} Media Kit", "Marketing", 15))

    meetings = base / "Meetings"
    for month in ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep"]:
        for meeting in ["All_Hands","Studio_Leads","Tech_Sync"]:
            write(meetings / "2024" / month / f"{meeting}_Notes_{month}_2024.docx",
                  make_docx(f"{meeting} {month} 2024"))


def gen_code_and_config():
    base = ROOT / "Engineering"
    print(f"\n[Engineering]")

    for game in GAMES[:3]:
        game_code = base / game

        script_map = {
            "AI":       ["enemy_behavior","pathfinding","squad_manager","boss_ai","npc_dialogue"],
            "Gameplay": ["player_controller","inventory","combat_system","quest_manager",
                         "save_system","loot_table","crafting","skill_tree"],
            "UI":       ["hud_controller","menu_manager","pause_menu","settings_screen",
                         "dialogue_box","tooltip_system"],
            "Utils":    ["event_bus","object_pool","state_machine","timer_manager",
                         "audio_manager","scene_loader"],
        }
        scripts = game_code / "Scripts"
        for category, names in script_map.items():
            for name in names:
                write(scripts / category / f"{name}.lua", make_lua(name))
                write(scripts / category / f"{name}.cs",
                      make_csharp("".join(w.capitalize() for w in name.split("_"))))

        configs = game_code / "Config"
        write(configs / "game_settings.json",
              make_json_data({"title": game, "version": rnd_version(), "debug": False,
                              "resolution": "1920x1080", "fps_cap": 60}))
        write(configs / "audio_config.json",
              make_json_data({"master_vol": 0.8, "music_vol": 0.7, "sfx_vol": 0.9}))
        write(configs / "input_bindings.json",
              make_json_data({"jump": "Space", "attack": "LMB", "interact": "E", "sprint": "Shift"}))
        write(configs / "balance_params.json",
              make_json_data({"player_hp": 100, "enemy_hp_base": 50,
                              "crit_chance": 0.15, "xp_multiplier": 1.0}))
        write(configs / "loot_tables.json",
              make_json_data({"common": 0.6, "uncommon": 0.25, "rare": 0.12, "legendary": 0.03}))

        ci = game_code / "CI"
        write(ci / "build.bat",
              b"@echo off\necho Building " + game.encode() + b"...\npython build.py --release\n")
        write(ci / "run_tests.bat", b"@echo off\npytest tests/ -q\n")
        write(ci / "deploy.bat",   b"@echo off\necho Deploying to staging...\n")
        write(ci / "changelog.md",
              make_markdown(f"{game} Changelog",
                            "\n".join([f"## {rnd_version()} ({rnd_date()})\n- Fixed bug X\n- Added feature Y"
                                       for _ in range(10)])))

        data = game_code / "Data"
        item_rows = [["item_id","name","type","rarity","damage","weight","value"]]
        for i in range(1, random.randint(100, 300)):
            item_rows.append([
                f"ITEM_{i:04d}",
                f"{random.choice(['Iron','Steel','Shadow','Void','Fire','Ice','Storm'])}"
                f" {random.choice(['Sword','Axe','Bow','Staff','Shield','Ring','Helmet'])}",
                random.choice(["weapon","armor","consumable","quest","misc"]),
                random.choice(["common","uncommon","rare","epic","legendary"]),
                random.randint(5, 200),
                round(random.uniform(0.1, 20.0), 1),
                random.randint(10, 10000),
            ])
        write(data / "items.csv", make_csv_data(item_rows))

        npc_xml = "<dialogues>\n" + "\n".join([
            f'  <dialogue id="{i:03d}" npc="Guard_{random.randint(1,10)}">'
            f'<line>{random.choice(["Halt! Who goes there?","State your business!","Move along.","Welcome to the city."])}</line>'
            f'</dialogue>'
            for i in range(1, 50)
        ]) + "\n</dialogues>"
        write(data / "npc_dialogues.xml", make_xml(npc_xml))

        quest_data = {"quests": [
            {"id": f"QST_{i:03d}", "name": f"Quest {i}",
             "type": random.choice(["main","side","daily"]),
             "xp_reward": random.randint(100, 5000),
             "gold_reward": random.randint(10, 500)}
            for i in range(1, random.randint(40, 80))
        ]}
        write(data / "quests.json", make_json_data(quest_data))

        levels = game_code / "Levels"
        for i in range(1, random.randint(8, 20)):
            write(levels / f"level_{i:02d}.json",
                  make_json_data({
                      "level": i, "name": f"Chapter {i}",
                      "enemies": random.randint(10, 100),
                      "objectives": random.randint(1, 5),
                      "music_track": f"battle_{random.randint(1,3):02d}",
                  }))


def gen_photography_and_reference():
    base = ROOT / "Photography_and_Reference"
    print(f"\n[Photography_and_Reference]")

    ref_cats = {
        "Architecture":   ["medieval_castle","sci_fi_city","ruins","interior_cave",
                           "bridge","skyscraper","village","temple"],
        "Nature":         ["forest_dense","desert_dunes","mountain_snow","ocean_sunset",
                           "swamp","tundra","volcanic","canyon"],
        "Characters_Ref": ["armor_medieval","futuristic_suit","casual_modern",
                           "fantasy_robe","military_tactical"],
        "Vehicles_Ref":   ["tank","spaceship","horse_and_cart","motorcycle","submarine","airship"],
        "Materials_Ref":  ["stone_wall","wood_plank","rusted_metal","glass_surface",
                           "fabric_woven","leather","crystal"],
        "Lighting_Ref":   ["golden_hour","overcast","neon_night","underground","underwater","foggy"],
    }
    for cat, items in ref_cats.items():
        for item in items:
            for i in range(1, random.randint(3, 10)):
                write(base / cat / f"{item}_{i:02d}.jpg", make_jpeg())
                if random.random() < 0.3:
                    write(base / cat / f"{item}_{i:02d}.png", make_png(1920, 1080))

    for event in ["gamescom_2022","gamescom_2023","e3_2022","gdc_2024",
                  "team_offsite_2023","launch_party_neon_citadel"]:
        for i in range(1, random.randint(10, 40)):
            write(base / "Events" / event / f"{event}_{i:03d}.jpg", make_jpeg())

    for game in GAMES[:4]:
        write(base / "Mood_Boards" / game / f"{game}_visual_direction.psd", make_psd(3840, 2160))
        write(base / "Mood_Boards" / game / f"{game}_color_script.psd",     make_psd(2560, 1440))
        write(base / "Mood_Boards" / game / f"{game}_mood_board_v1.png",    make_png(1920, 1080))


def gen_marketing_assets():
    base = ROOT / "Marketing_Assets"
    print(f"\n[Marketing_Assets]")

    for game in GAMES[:5]:
        game_mkt = base / game

        social = game_mkt / "Social_Media"
        for platform in ["Twitter_X","Instagram","Facebook","TikTok","YouTube"]:
            for post_type in ["announcement","update","fan_art_feature","countdown"]:
                for size_label in ["1080x1080","1920x1080","1080x1920"]:
                    write(social / platform / f"{post_type}_{size_label}.png", make_png(256, 256))
                    write(social / platform / f"{post_type}_{size_label}.psd", make_psd(256, 256))

        keyart = game_mkt / "Key_Art"
        for variant in ["landscape","portrait","square","banner","wide"]:
            write(keyart / f"{game.lower()}_keyart_{variant}.psd", make_psd(1920, 1080))
            write(keyart / f"{game.lower()}_keyart_{variant}.png", make_png(1920, 1080))
            write(keyart / f"{game.lower()}_keyart_{variant}.jpg", make_jpeg(1920, 1080))

        for store in ["Steam","Epic_Games","PlayStation","Xbox"]:
            store_dir = game_mkt / "Store_Assets" / store
            for asset in ["capsule_sm","capsule_md","capsule_lg","header_image",
                          "background","icon",
                          "screenshot_01","screenshot_02","screenshot_03",
                          "screenshot_04","screenshot_05"]:
                write(store_dir / f"{asset}.png", make_png(256, 256))

        print_dir = game_mkt / "Print"
        for item in ["poster_A1","flyer_A5","banner_rollup","t_shirt_design",
                     "collector_box_front","collector_box_back","sticker_sheet"]:
            write(print_dir / f"{item}.pdf", make_pdf(item, "Marketing", 1))
            write(print_dir / f"{item}.psd", make_psd(1024, 1024))


def gen_localisation():
    base = ROOT / "Localisation"
    print(f"\n[Localisation]")

    languages = {
        "EN": "English",   "DE": "German",    "FR": "French",
        "ES": "Spanish",   "JP": "Japanese",  "KO": "Korean",
        "ZH_CN": "Chinese Simplified",         "PT_BR": "Portuguese BR",
        "IT": "Italian",   "RU": "Russian",   "PL": "Polish",
    }
    for game in GAMES:
        for lang_code, lang_name in languages.items():
            d = base / game / lang_code
            strings = {
                "ui.button.play":    "Play" if lang_code == "EN" else f"[{lang_code}] Play",
                "ui.button.settings":"Settings" if lang_code == "EN" else f"[{lang_code}] Settings",
                "quest.001.title":   f"The Beginning ({lang_name})",
                "npc.guard.greeting": f"Hello traveller ({lang_name})",
            }
            write(d / f"strings_{lang_code}.json", make_json_data(strings))
            write(d / f"strings_{lang_code}.xml",
                  make_xml(f"<strings lang='{lang_code}'>" +
                           "".join(f"<str key='{k}'>{v}</str>" for k,v in strings.items()) +
                           "</strings>"))


def gen_pipeline_and_tools():
    base = ROOT / "Pipeline_and_Tools"
    print(f"\n[Pipeline_and_Tools]")

    write(base / "Art_Pipeline" / "Texture_Pipeline_Guide.pdf",
          make_pdf("Texture Pipeline", "Tech Art", 25))
    write(base / "Art_Pipeline" / "Model_Export_SOP.pdf",
          make_pdf("Model Export SOP", "Tech Art", 15))
    write(base / "Art_Pipeline" / "Rig_Conventions.docx", make_docx("Rigging Conventions"))
    write(base / "Audio_Pipeline" / "Audio_Implementation_Guide.pdf",
          make_pdf("Audio Implementation", "Audio", 20))
    write(base / "Audio_Pipeline" / "Wwise_Project_Template.pdf",
          make_pdf("Wwise Template", "Audio", 10))
    write(base / "Build_System" / "CI_CD_Overview.pdf",
          make_pdf("CI/CD Overview", "DevOps", 18))
    write(base / "Build_System" / "Branching_Strategy.docx", make_docx("Branching Strategy"))
    write(base / "Build_System" / "Version_Numbering.md",
          make_markdown("Version Numbering",
                        "## Semantic Versioning\nWe use MAJOR.MINOR.PATCH across all titles.\n"))

    analytics = base / "Analytics"
    for game in GAMES[:3]:
        for report in ["dau","retention_D1_D7_D30","session_length",
                       "monetisation","crash_report","performance_metrics"]:
            write(analytics / game / f"{report}_{rnd_date()}.csv",
                  make_csv_data([
                      ["date","value","segment"],
                      *[[rnd_date(), random.randint(0,100000),
                         random.choice(["PC","Console","Mobile"])]
                        for _ in range(random.randint(30, 90))]
                  ]))
            write(analytics / game / f"{report}_{rnd_date()}.xlsx", make_xlsx())


def gen_archive_and_shipped():
    base = ROOT / "_Archive"
    print(f"\n[_Archive]")

    for year in [2019, 2020, 2021]:
        year_dir = base / str(year)
        for i in range(1, 4):
            game_name = f"Project_Alpha_{i}" if year < 2021 else f"Project_Beta_{i}"
            write(year_dir / game_name / "GDD_final.pdf",
                  make_pdf(f"{game_name} GDD", "Design Team", 80))
            write(year_dir / game_name / "Build_master.docx", make_docx("Master Build Notes"))
            for j in range(1, 6):
                write(year_dir / game_name / "Screenshots" / f"final_{j:02d}.jpg", make_jpeg())
            write(year_dir / game_name / "Launch_Trailer.mp4", make_mp4(90.0))
            write(year_dir / game_name / "OST_Complete.flac",  make_flac(3600.0))

    for proj in ["Project_Labyrinth","Operation_Mirage","TitanForge"]:
        d = base / "Cancelled" / proj
        write(d / "GDD_draft.docx",          make_docx(f"{proj} Draft"))
        write(d / "Concept_Art.psd",         make_psd())
        write(d / "Cancellation_Memo.pdf",   make_pdf("Cancellation Memo", "Studio Head", 2))


def gen_shared_resources():
    base = ROOT / "_Shared"
    print(f"\n[_Shared]")

    fonts = base / "Fonts"
    for font_name in ["HermesUI","HermesBold","HermesDisplay","HermesMonospace",
                      "NeonCitadel_Display","VortexRising_Title","EchoWraith_Text"]:
        for style in ["Regular","Bold","Italic","BoldItalic"]:
            write(fonts / font_name / f"{font_name}-{style}.ttf",
                  b"\x00\x01\x00\x00" + random.randbytes(random.randint(4096, 65536)))
            if random.random() < 0.5:
                write(fonts / font_name / f"{font_name}-{style}.otf",
                      b"OTTO" + random.randbytes(random.randint(4096, 65536)))

    ui_kit = base / "UI_Kit"
    for component in ["buttons","icons","backgrounds","borders","cursors",
                      "progress_bars","tooltips","modals","notifications"]:
        for i in range(1, random.randint(4, 12)):
            write(ui_kit / component / f"{component}_{i:02d}.png", make_png(128, 128))
            write(ui_kit / component / f"{component}_{i:02d}.svg", make_svg(f"{component}_{i}"))

    common_audio = base / "Common_Audio"
    for sound in ["ui_click","ui_confirm","ui_back","notification_ding",
                  "hermes_logo_sting","achievement_unlock"]:
        write(common_audio / f"{sound}.wav", make_wav(random.uniform(0.5, 3.0)))
        write(common_audio / f"{sound}.ogg", make_ogg(random.uniform(0.5, 3.0)))

    wiki = base / "Wiki_Exports"
    for topic in ["Onboarding_Guide","Code_Standards","Art_Style_Guide",
                  "Security_Policy","Release_Process","Accessibility_Guidelines",
                  "Localization_Workflow","QA_Standards","Audio_Implementation",
                  "Postmortem_Template"]:
        write(wiki / f"{topic}.pdf",  make_pdf(topic.replace("_"," "), "Hermes Media", random.randint(5,40)))
        write(wiki / f"{topic}.docx", make_docx(topic.replace("_"," ")))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("=== Hermes Media Mock Library Generator ===")
    print(f"Output root: {ROOT.resolve()}\n")

    ROOT.mkdir(parents=True, exist_ok=True)

    gen_brand_identity()
    gen_art_assets()
    gen_audio()
    gen_video()
    gen_documents()
    gen_code_and_config()
    gen_photography_and_reference()
    gen_marketing_assets()
    gen_localisation()
    gen_pipeline_and_tools()
    gen_archive_and_shipped()
    gen_shared_resources()

    all_files = list(ROOT.rglob("*"))
    files_only = [f for f in all_files if f.is_file()]
    dirs_only  = [f for f in all_files if f.is_dir()]
    total_bytes = sum(f.stat().st_size for f in files_only)

    print(f"\n{'='*50}")
    print(f"  Directories : {len(dirs_only):>6,}")
    print(f"  Files       : {len(files_only):>6,}")
    print(f"  Total size  : {total_bytes / 1_048_576:>8.1f} MB")
    print(f"{'='*50}")
    print(f"\nLibrary ready at: {ROOT.resolve()}")
