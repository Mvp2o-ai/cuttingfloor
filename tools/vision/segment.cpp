// cf-segment: the subject of a picture separated from its background, as a subprocess.
//
//   cf-segment MODEL WIDTH HEIGHT SMOOTH [THREADS]
//
// Reads raw BGR24 frames of WIDTH x HEIGHT on stdin and writes one 8-bit alpha frame of the same
// size per frame. MODEL is BiRefNet (MIT) as ONNX, run with ONNX Runtime on the CPU at its own
// 1024 x 1024: ImageNet-normalised RGB in, logits out (sigmoid gives the matte). SMOOTH 0–0.9
// blends in the previous frame's matte to steady video. Nothing else is read or written.

#include <onnxruntime_cxx_api.h>

#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>

static bool readFrame(std::vector<unsigned char>& buf) {
  size_t got = 0;
  while (got < buf.size()) {
    size_t n = fread(buf.data() + got, 1, buf.size() - got, stdin);
    if (n == 0) return false;
    got += n;
  }
  return true;
}

int main(int argc, char** argv) {
  if (argc != 5 && argc != 6) {
    std::cerr << "usage: cf-segment MODEL W H SMOOTH [THREADS]\n";
    return 2;
  }
  const int w = std::atoi(argv[2]);
  const int h = std::atoi(argv[3]);
  const double smooth = std::atof(argv[4]);
  const int threads = argc == 6 ? std::atoi(argv[5]) : 4;
  if (w <= 0 || h <= 0 || smooth < 0 || smooth > 0.9 || threads <= 0) {
    std::cerr << "cf-segment: bad arguments\n";
    return 2;
  }
  cv::setNumThreads(1);
  try {
    Ort::Env env(ORT_LOGGING_LEVEL_ERROR, "cf-segment");
    Ort::SessionOptions options;
    options.SetIntraOpNumThreads(threads);
    options.SetInterOpNumThreads(1);
    options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
    // Peak memory, not speed, is what runs out in a container: no arena, no pre-planned
    // buffers, so freed activations are given back as the graph runs.
    options.DisableCpuMemArena();
    options.DisableMemPattern();
    options.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
    Ort::Session session(env, argv[1], options);
    Ort::AllocatorWithDefaultOptions alloc;
    auto inName = session.GetInputNameAllocated(0, alloc);
    auto outName = session.GetOutputNameAllocated(0, alloc);
    const char* inNames[] = {inName.get()};
    const char* outNames[] = {outName.get()};

    constexpr int S = 1024;
    const std::array<int64_t, 4> shape{1, 3, S, S};
    const float mean[3] = {0.485f, 0.456f, 0.406f};
    const float stdev[3] = {0.229f, 0.224f, 0.225f};
    std::vector<float> input(3 * S * S);
    Ort::MemoryInfo memory = Ort::MemoryInfo::CreateCpu(OrtDeviceAllocator, OrtMemTypeDefault);

    std::vector<unsigned char> buf(static_cast<size_t>(w) * h * 3);
    cv::Mat previous;
    while (readFrame(buf)) {
      cv::Mat img(h, w, CV_8UC3, buf.data());
      cv::Mat resized;
      cv::resize(img, resized, cv::Size(S, S), 0, 0, cv::INTER_LINEAR);
      // BGR bytes to planar, normalised RGB.
      for (int y = 0; y < S; y++) {
        const unsigned char* row = resized.ptr<unsigned char>(y);
        for (int x = 0; x < S; x++) {
          for (int c = 0; c < 3; c++) {
            const float v = row[x * 3 + (2 - c)] / 255.0f;
            input[static_cast<size_t>(c) * S * S + static_cast<size_t>(y) * S + x] =
                (v - mean[c]) / stdev[c];
          }
        }
      }
      Ort::Value tensor = Ort::Value::CreateTensor<float>(memory, input.data(), input.size(),
                                                          shape.data(), shape.size());
      auto outputs = session.Run(Ort::RunOptions{nullptr}, inNames, &tensor, 1, outNames, 1);
      auto info = outputs[0].GetTensorTypeAndShapeInfo();
      auto dims = info.GetShape();
      const int oh = static_cast<int>(dims[dims.size() - 2]);
      const int ow = static_cast<int>(dims[dims.size() - 1]);
      float* logits = outputs[0].GetTensorMutableData<float>();
      cv::Mat matte(oh, ow, CV_32F);
      for (int i = 0; i < oh * ow; i++) {
        matte.ptr<float>()[i] = 1.0f / (1.0f + std::exp(-logits[i]));
      }
      cv::Mat full;
      cv::resize(matte, full, cv::Size(w, h), 0, 0, cv::INTER_LINEAR);
      if (smooth > 0 && !previous.empty()) cv::addWeighted(previous, smooth, full, 1 - smooth, 0, full);
      previous = full;
      cv::Mat bytes;
      full.convertTo(bytes, CV_8U, 255.0);
      std::fwrite(bytes.data, 1, bytes.total(), stdout);
    }
    std::fflush(stdout);
  } catch (const Ort::Exception& e) {
    std::cerr << "cf-segment: " << e.what() << "\n";
    return 1;
  }
  return 0;
}
