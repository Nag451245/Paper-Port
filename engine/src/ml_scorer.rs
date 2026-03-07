use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
struct ScorerInput {
    command: String,
    #[serde(default)]
    features: Option<Vec<FeatureRow>>,
    #[serde(default)]
    weights: Option<ModelWeights>,
    #[serde(default)]
    training_data: Option<Vec<TrainingRow>>,
    #[serde(default)]
    learning_rate: Option<f64>,
    #[serde(default)]
    epochs: Option<usize>,
    #[serde(default)]
    strategy_stats: Option<Vec<StrategyStats>>,
    #[serde(default)]
    total_capital: Option<f64>,
}

#[derive(Deserialize, Serialize, Clone)]
struct StrategyStats {
    strategy_id: String,
    wins: u32,
    losses: u32,
    sharpe: f64,
    #[serde(default)]
    is_decaying: bool,
}

#[derive(Deserialize, Serialize, Clone)]
struct FeatureRow {
    #[serde(default)] ema_vote: f64,
    #[serde(default)] rsi_vote: f64,
    #[serde(default)] macd_vote: f64,
    #[serde(default)] supertrend_vote: f64,
    #[serde(default)] bollinger_vote: f64,
    #[serde(default)] vwap_vote: f64,
    #[serde(default)] momentum_vote: f64,
    #[serde(default)] volume_vote: f64,
    #[serde(default)] composite_score: f64,
    #[serde(default)] regime: f64,
    #[serde(default)] hour_of_day: f64,
    #[serde(default)] day_of_week: f64,
    #[serde(default)] raw_features: Vec<f64>,
}

#[derive(Deserialize, Serialize, Clone)]
struct TrainingRow {
    features: FeatureRow,
    outcome: f64, // 1.0 = WIN, 0.0 = LOSS
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ModelWeights {
    pub w: Vec<f64>,
    pub bias: f64,
    pub feature_names: Vec<String>,
    pub training_samples: usize,
    pub training_accuracy: f64,
}

#[derive(Serialize)]
struct PredictOutput {
    scores: Vec<f64>,
    model_version: String,
}

#[derive(Serialize)]
struct TrainOutput {
    weights: ModelWeights,
    training_loss: f64,
    training_accuracy: f64,
    samples_used: usize,
}

fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

fn feature_vec(f: &FeatureRow) -> Vec<f64> {
    let mut v = vec![
        f.ema_vote, f.rsi_vote, f.macd_vote, f.supertrend_vote,
        f.bollinger_vote, f.vwap_vote, f.momentum_vote, f.volume_vote,
        f.composite_score, f.regime, f.hour_of_day / 24.0, f.day_of_week / 7.0,
    ];
    // Append raw features from the expanded feature store if available
    for &rf in &f.raw_features {
        v.push(rf);
    }
    v
}

fn predict_one(features: &[f64], weights: &[f64], bias: f64) -> f64 {
    let z: f64 = features.iter().zip(weights.iter()).map(|(f, w)| f * w).sum::<f64>() + bias;
    sigmoid(z)
}

fn train_logistic(data: &[TrainingRow], lr: f64, epochs: usize) -> (Vec<f64>, f64, f64, f64) {
    let n_features = feature_vec(&data[0].features).len();
    let mut w = vec![0.0f64; n_features];
    let mut bias = 0.0f64;
    let n = data.len() as f64;

    for _ in 0..epochs {
        let mut dw = vec![0.0f64; n_features];
        let mut db = 0.0f64;

        for row in data {
            let x = feature_vec(&row.features);
            let pred = predict_one(&x, &w, bias);
            let err = pred - row.outcome;

            for j in 0..n_features {
                dw[j] += err * x[j];
            }
            db += err;
        }

        for j in 0..n_features {
            w[j] -= lr * (dw[j] / n + 0.001 * w[j]); // L2 regularization
        }
        bias -= lr * db / n;
    }

    // Compute final loss and accuracy
    let mut total_loss = 0.0_f64;
    let mut correct = 0usize;
    for row in data {
        let x = feature_vec(&row.features);
        let pred = predict_one(&x, &w, bias);
        let y = row.outcome;
        total_loss += -(y * pred.max(1e-15).ln() + (1.0 - y) * (1.0 - pred).max(1e-15).ln());
        let predicted_class = if pred >= 0.5 { 1.0 } else { 0.0 };
        if (predicted_class - y).abs() < 0.01 { correct += 1; }
    }
    let avg_loss = total_loss / data.len() as f64;
    let accuracy = correct as f64 / data.len() as f64;

    (w, bias, accuracy, avg_loss)
}

pub fn compute(data: Value) -> Result<Value, String> {
    let input: ScorerInput =
        serde_json::from_value(data).map_err(|e| format!("Invalid ML scorer input: {}", e))?;

    match input.command.as_str() {
        "predict" => {
            let features = input.features.ok_or("features required for predict")?;
            let weights = input.weights.ok_or("weights required for predict")?;

            if features.is_empty() {
                return Ok(serde_json::json!({
                    "scores": [],
                    "threshold": 0.55,
                    "model_accuracy": weights.training_accuracy,
                }));
            }

            let expected_dim = feature_vec(&features[0]).len();
            if weights.w.len() != expected_dim {
                return Err(format!("Weight dimension mismatch: model has {} weights, features produce {} values", weights.w.len(), expected_dim));
            }

            let scores: Vec<f64> = features.iter().map(|f| {
                let x = feature_vec(f);
                let raw = predict_one(&x, &weights.w, weights.bias);
                (raw * 1000.0).round() / 1000.0
            }).collect();

            let output = PredictOutput {
                scores,
                model_version: format!("logreg_v1_{}", weights.training_samples),
            };

            serde_json::to_value(output).map_err(|e| format!("Serialization error: {}", e))
        }

        "train" => {
            let training_data = input.training_data.ok_or("training_data required for train")?;

            if training_data.len() < 10 {
                return Err("Need at least 10 training samples".to_string());
            }

            let lr = input.learning_rate.unwrap_or(0.01);
            let epochs = input.epochs.unwrap_or(500).min(5000);

            let (w, bias, accuracy, avg_loss) = train_logistic(&training_data, lr, epochs);

            let base_names = vec![
                "ema_vote", "rsi_vote", "macd_vote", "supertrend_vote",
                "bollinger_vote", "vwap_vote", "momentum_vote", "volume_vote",
                "composite_score", "regime", "hour_of_day", "day_of_week",
            ];
            let n_raw = if !training_data.is_empty() { training_data[0].features.raw_features.len() } else { 0 };
            let mut feature_names: Vec<String> = base_names.into_iter().map(String::from).collect();
            for i in 0..n_raw {
                feature_names.push(format!("raw_{}", i));
            }

            let output = TrainOutput {
                weights: ModelWeights {
                    w: w.iter().map(|v| (v * 10000.0).round() / 10000.0).collect(),
                    bias: (bias * 10000.0).round() / 10000.0,
                    feature_names,
                    training_samples: training_data.len(),
                    training_accuracy: (accuracy * 1000.0).round() / 1000.0,
                },
                training_loss: (avg_loss * 10000.0).round() / 10000.0,
                training_accuracy: (accuracy * 1000.0).round() / 1000.0,
                samples_used: training_data.len(),
            };

            serde_json::to_value(output).map_err(|e| format!("Serialization error: {}", e))
        }

        "allocate" => {
            let stats = input.strategy_stats.ok_or("strategy_stats required for allocate")?;
            let total_capital = input.total_capital.unwrap_or(1_000_000.0);

            if stats.is_empty() {
                return Err("At least one strategy required".to_string());
            }

            // Thompson sampling: sample from Beta(wins+1, losses+1) for each strategy
            // Using deterministic approximation: mean of Beta distribution
            let mut raw_scores: Vec<(String, f64)> = stats.iter().map(|s| {
                let alpha = s.wins as f64 + 1.0;
                let beta = s.losses as f64 + 1.0;
                let mean = alpha / (alpha + beta);
                let decay_penalty = if s.is_decaying { 0.5 } else { 1.0 };
                let sharpe_bonus = (s.sharpe.max(0.0) * 0.1).min(0.3);
                let score = (mean + sharpe_bonus) * decay_penalty;
                (s.strategy_id.clone(), score)
            }).collect();

            let total_score: f64 = raw_scores.iter().map(|(_, s)| s).sum();
            if total_score <= 0.0 {
                let equal = 1.0 / stats.len() as f64;
                let allocations: Vec<serde_json::Value> = stats.iter().map(|s| {
                    serde_json::json!({
                        "strategy_id": s.strategy_id,
                        "allocation_pct": (equal * 100.0 * 100.0).round() / 100.0,
                        "capital": (total_capital * equal * 100.0).round() / 100.0,
                        "score": 0.0,
                    })
                }).collect();
                return serde_json::to_value(serde_json::json!({
                    "allocations": allocations,
                    "method": "equal_weight",
                })).map_err(|e| e.to_string());
            }

            for entry in &mut raw_scores {
                entry.1 /= total_score;
            }

            // Apply minimum allocation floor (5%) and maximum cap (40%)
            let n = raw_scores.len() as f64;
            let min_alloc = (0.05f64).min(1.0 / n);
            let max_alloc = 0.40f64;

            let allocations: Vec<serde_json::Value> = raw_scores.iter().map(|(id, score)| {
                let alloc = score.max(min_alloc).min(max_alloc);
                serde_json::json!({
                    "strategy_id": id,
                    "allocation_pct": (alloc * 100.0 * 100.0).round() / 100.0,
                    "capital": (total_capital * alloc * 100.0).round() / 100.0,
                    "score": (score * 1000.0).round() / 1000.0,
                })
            }).collect();

            serde_json::to_value(serde_json::json!({
                "allocations": allocations,
                "method": "thompson_sampling",
            })).map_err(|e| e.to_string())
        }

        _ => Err(format!("Unknown ML scorer command: {}", input.command)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_feature(composite: f64, momentum: f64) -> FeatureRow {
        FeatureRow {
            ema_vote: 0.5, rsi_vote: 0.3, macd_vote: 0.4, supertrend_vote: 0.6,
            bollinger_vote: 0.2, vwap_vote: 0.3, momentum_vote: momentum,
            volume_vote: 0.5, composite_score: composite,
            regime: 1.0, hour_of_day: 11.0, day_of_week: 2.0,
            raw_features: vec![],
        }
    }

    #[test]
    fn test_predict_with_zero_weights() {
        let features = vec![make_feature(0.5, 0.7)];
        let weights = ModelWeights {
            w: vec![0.0; 12], bias: 0.0,
            feature_names: vec![], training_samples: 0, training_accuracy: 0.0,
        };
        let input = json!({
            "command": "predict",
            "features": serde_json::to_value(&features).unwrap(),
            "weights": serde_json::to_value(&weights).unwrap(),
        });
        let result = compute(input).unwrap();
        let scores = result.get("scores").unwrap().as_array().unwrap();
        assert!((scores[0].as_f64().unwrap() - 0.5).abs() < 0.01, "zero weights should predict 0.5");
    }

    #[test]
    fn test_train_separable_data() {
        let mut data = Vec::new();
        for i in 0..50 {
            let composite = if i < 25 { 0.2 + (i as f64) * 0.01 } else { 0.6 + ((i - 25) as f64) * 0.01 };
            let outcome = if i < 25 { 0.0 } else { 1.0 };
            data.push(TrainingRow { features: make_feature(composite, composite), outcome });
        }
        let input = json!({
            "command": "train",
            "training_data": serde_json::to_value(&data).unwrap(),
            "epochs": 200,
        });
        let result = compute(input).unwrap();
        let acc = result.get("training_accuracy").unwrap().as_f64().unwrap();
        assert!(acc > 0.6, "should learn separable data, got accuracy {}", acc);
        let loss = result.get("training_loss").unwrap().as_f64().unwrap();
        assert!(loss > 0.0, "training_loss should be non-zero, got {}", loss);
    }

    #[test]
    fn test_sigmoid() {
        assert!((sigmoid(0.0) - 0.5).abs() < 1e-10);
        assert!(sigmoid(10.0) > 0.99);
        assert!(sigmoid(-10.0) < 0.01);
    }

    #[test]
    fn test_predict_positive_weights_high_composite() {
        let features = vec![make_feature(0.9, 0.8)];
        let weights = ModelWeights {
            w: vec![1.0; 12], bias: 0.0,
            feature_names: vec![], training_samples: 100, training_accuracy: 0.8,
        };
        let input = json!({
            "command": "predict",
            "features": serde_json::to_value(&features).unwrap(),
            "weights": serde_json::to_value(&weights).unwrap(),
        });
        let result = compute(input).unwrap();
        let scores = result.get("scores").unwrap().as_array().unwrap();
        assert!(scores[0].as_f64().unwrap() > 0.5, "high composite + positive weights should predict >0.5");
    }

    #[test]
    fn test_train_returns_weights() {
        let mut data = Vec::new();
        for i in 0..30 {
            let v = (i as f64) / 30.0;
            data.push(TrainingRow {
                features: make_feature(v, v),
                outcome: if v > 0.5 { 1.0 } else { 0.0 },
            });
        }
        let input = json!({
            "command": "train",
            "training_data": serde_json::to_value(&data).unwrap(),
            "epochs": 100,
        });
        let result = compute(input).unwrap();
        assert!(result.get("weights").is_some(), "train should return weights");
        assert!(result.get("training_accuracy").is_some(), "train should return accuracy");
    }

    #[test]
    fn test_predict_empty_features() {
        let weights = ModelWeights {
            w: vec![0.0; 12], bias: 0.0,
            feature_names: vec![], training_samples: 0, training_accuracy: 0.0,
        };
        let input = json!({
            "command": "predict",
            "features": [],
            "weights": serde_json::to_value(&weights).unwrap(),
        });
        let result = compute(input).unwrap();
        let scores = result.get("scores").unwrap().as_array().unwrap();
        assert_eq!(scores.len(), 0, "empty features should produce empty scores");
    }
}
