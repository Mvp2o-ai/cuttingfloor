// cf-vision: the computer-vision steps of media.analyze, as a subprocess.
//
//   cf-vision faces MODEL WIDTH HEIGHT
//   cf-vision track WIDTH HEIGHT X Y W H
//
// Both read raw BGR24 frames of WIDTH x HEIGHT on stdin and write one JSON line per frame:
//   faces: [[x, y, w, h, score], ...]   (pixels, YuNet face detector)
//   track: [x, y, w, h, found]           (pixels, CSRT tracker; the first frame is the box given)
// Nothing else is read or written, so it can run with no network and no files but the model.

#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include <opencv2/core.hpp>
#include <opencv2/objdetect.hpp>
#include <opencv2/tracking.hpp>

static bool readFrame(std::vector<unsigned char>& buf) {
  size_t got = 0;
  while (got < buf.size()) {
    size_t n = fread(buf.data() + got, 1, buf.size() - got, stdin);
    if (n == 0) return false;
    got += n;
  }
  return true;
}

static int usage() {
  std::cerr << "usage: cf-vision faces MODEL W H | cf-vision track W H X Y BW BH\n";
  return 2;
}

int main(int argc, char** argv) {
  if (argc < 2) return usage();
  std::string mode = argv[1];
  cv::setNumThreads(2);

  if (mode == "faces" && argc == 5) {
    int w = std::atoi(argv[3]);
    int h = std::atoi(argv[4]);
    if (w <= 0 || h <= 0) return usage();
    auto detector = cv::FaceDetectorYN::create(argv[2], "", cv::Size(w, h), 0.6f, 0.3f, 50);
    std::vector<unsigned char> buf(static_cast<size_t>(w) * h * 3);
    while (readFrame(buf)) {
      cv::Mat img(h, w, CV_8UC3, buf.data());
      cv::Mat faces;
      detector->detect(img, faces);
      std::string out = "[";
      for (int i = 0; i < faces.rows; i++) {
        const float* f = faces.ptr<float>(i);
        char item[160];
        std::snprintf(item, sizeof item, "%s[%.1f,%.1f,%.1f,%.1f,%.3f]", i ? "," : "", f[0], f[1], f[2],
                      f[3], f[14]);
        out += item;
      }
      std::cout << out << "]\n";
    }
    return 0;
  }

  if (mode == "track" && argc == 8) {
    int w = std::atoi(argv[2]);
    int h = std::atoi(argv[3]);
    cv::Rect box(std::atoi(argv[4]), std::atoi(argv[5]), std::atoi(argv[6]), std::atoi(argv[7]));
    if (w <= 0 || h <= 0 || box.width <= 0 || box.height <= 0) return usage();
    cv::Ptr<cv::Tracker> tracker = cv::TrackerCSRT::create();
    std::vector<unsigned char> buf(static_cast<size_t>(w) * h * 3);
    bool first = true;
    while (readFrame(buf)) {
      cv::Mat img(h, w, CV_8UC3, buf.data());
      bool found = true;
      if (first) {
        tracker->init(img, box);
        first = false;
      } else {
        found = tracker->update(img, box);
      }
      std::cout << "[" << box.x << "," << box.y << "," << box.width << "," << box.height << ","
                << (found ? 1 : 0) << "]\n";
    }
    return 0;
  }
  return usage();
}
