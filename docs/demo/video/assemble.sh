#!/bin/sh
# Assemble clips/*.webm (from record.mjs) into osd-demo-1080.mp4, osd-demo-x.mp4, poster.jpg. Needs ffmpeg.
set -e
cd "$(dirname "$0")"
mkdir -p clips/seg
: > clips/list.txt
for spec in 01-home:0.5:5.5 02-how:0.5:6 03-sealed:0.5:8 04-replay:0.6:13.5 04b-replay-cc:0.5:5 05-population:0.5:6 05b-leaderboard:0.4:3 05c-agent:0.5:7 06-attacks:0.5:8 06b-terminal:0.4:5 07-seal:0.4:5 08-cta:0.4:8; do
  n=${spec%%:*}; r=${spec#*:}; ss=${r%%:*}; t=${r#*:}
  ffmpeg -v error -y -ss "$ss" -t "$t" -i "clips/$n.webm" -vf "scale=1920:1080:flags=lanczos,fps=30,format=yuv420p" -c:v libx264 -crf 20 -preset slow -an "clips/seg/$n.mp4"
  echo "file 'seg/$n.mp4'" >> clips/list.txt
done
ffmpeg -v error -y -f concat -safe 0 -i clips/list.txt -c copy osd-demo-1080.mp4
ffmpeg -v error -y -i osd-demo-1080.mp4 -vf scale=1280:720:flags=lanczos -c:v libx264 -crf 24 -preset slow -maxrate 2M -bufsize 4M -pix_fmt yuv420p -movflags +faststart osd-demo-x.mp4
ffmpeg -v error -y -ss 3.5 -i osd-demo-1080.mp4 -frames:v 1 -q:v 3 poster.jpg
